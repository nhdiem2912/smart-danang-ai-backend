import math
from contextlib import asynccontextmanager
from typing import Annotated, Literal

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Query,
)
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from database import (
    Category,
    Poi,
    get_session,
    init_db,
    normalize_search,
)


CategoryFilter = Literal[
    "all",
    "tham_quan",
    "an_uong",
    "mua_sam",
    "khach_san",
    "giai_tri",
    "bai_bien",
]

DB = Annotated[
    Session,
    Depends(get_session),
]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Smart Da Nang Places API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def active_query(category):
    statement = select(Poi).where(
        Poi.legacy_only.is_(False)
    )

    if category != "all":
        statement = statement.where(
            Poi.category == category
        )

    return statement


@app.get("/api/health")
def health(db: DB):
    total = db.scalar(
        select(func.count())
        .select_from(Poi)
    )

    active = db.scalar(
        select(func.count())
        .select_from(Poi)
        .where(Poi.legacy_only.is_(False))
    )

    return {
        "status": "ok",
        "places_total": total,
        "places_active": active,
    }


@app.get("/api/categories")
def categories(db: DB):
    statement = (
        select(
            Category.id,
            Category.name,
            func.count(Poi.id).label("count"),
        )
        .outerjoin(
            Poi,
            (Poi.category == Category.id)
            & Poi.legacy_only.is_(False),
        )
        .group_by(
            Category.id,
            Category.name,
        )
        .order_by(Category.id)
    )

    return {
        "items": [
            dict(row._mapping)
            for row in db.execute(statement)
        ]
    }


@app.get("/api/pois")
def list_pois(
    db: DB,
    category: CategoryFilter = "all",
    query: str = Query(
        default="",
        max_length=200,
    ),
    offset: int = Query(
        default=0,
        ge=0,
    ),
    limit: int = Query(
        default=20,
        ge=1,
        le=100,
    ),
):
    statement = active_query(category)

    keyword = normalize_search(query)

    if keyword:
        statement = statement.where(
            Poi.search_text.contains(
                keyword,
                autoescape=True,
            )
        )

    total = db.scalar(
        select(func.count())
        .select_from(statement.subquery())
    ) or 0

    rows = db.scalars(
        statement
        .order_by(Poi.id)
        .offset(offset)
        .limit(limit)
    ).all()

    next_offset = offset + len(rows)

    return {
        "items": [
            row.payload
            for row in rows
        ],
        "total": total,
        "nextOffset": (
            next_offset
            if next_offset < total
            else None
        ),
    }


def distance_km(
    lat1,
    lon1,
    lat2,
    lon2,
):
    a = math.radians(lat1)
    b = math.radians(lat2)

    dlat = b - a
    dlon = math.radians(lon2 - lon1)

    value = (
        math.sin(dlat / 2) ** 2
        + math.cos(a)
        * math.cos(b)
        * math.sin(dlon / 2) ** 2
    )

    return (
        6371.0088
        * 2
        * math.asin(
            math.sqrt(
                max(0, min(1, value))
            )
        )
    )


@app.get("/api/pois/nearby")
def nearby(
    db: DB,
    lat: float = Query(
        ge=-90,
        le=90,
        allow_inf_nan=False,
    ),
    lon: float = Query(
        ge=-180,
        le=180,
        allow_inf_nan=False,
    ),
    radius_km: float = Query(
        default=5,
        gt=0,
        le=100,
        allow_inf_nan=False,
    ),
    category: CategoryFilter = "all",
    offset: int = Query(
        default=0,
        ge=0,
    ),
    limit: int = Query(
        default=20,
        ge=1,
        le=100,
    ),
):
    rows = db.scalars(
        active_query(category)
        .where(
            Poi.coordinates_valid.is_(True)
        )
    )

    matches = []

    for row in rows:
        distance = distance_km(
            lat,
            lon,
            row.latitude,
            row.longitude,
        )

        if distance <= radius_km:
            matches.append(
                (distance, row)
            )

    matches.sort(
        key=lambda pair: (
            pair[0],
            pair[1].id,
        )
    )

    items = [
        {
            **row.payload,
            "distance_km": round(distance, 3),
        }
        for distance, row in matches[
            offset:offset + limit
        ]
    ]

    next_offset = offset + len(items)

    return {
        "items": items,
        "total": len(matches),
        "nextOffset": (
            next_offset
            if next_offset < len(matches)
            else None
        ),
    }


@app.get("/api/pois/{poi_id:path}")
def detail(
    poi_id: str,
    db: DB,
):
    poi = db.get(Poi, poi_id)

    if poi is None:
        raise HTTPException(
            status_code=404,
            detail="Không tìm thấy địa điểm.",
        )

    return poi.payload
@app.get("/api/catalog")
def catalog(db: DB):
    rows = db.scalars(
        select(Poi).order_by(Poi.id)
    ).all()

    return {
        "items": [
            row.payload
            for row in rows
        ],
        "total": len(rows),
    }