import os
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import (
    JSON,
    Boolean,
    Float,
    ForeignKey,
    String,
    Text,
    create_engine,
    event,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    sessionmaker,
)


CATEGORIES = {
    "tham_quan": "Tham quan",
    "an_uong": "Ăn uống",
    "mua_sam": "Mua sắm",
    "khach_san": "Khách sạn",
    "giai_tri": "Giải trí",
    "bai_bien": "Bãi biển",
}


def normalize_search(value: str) -> str:
    text = unicodedata.normalize("NFD", value)

    text = "".join(
        character
        for character in text
        if not unicodedata.combining(character)
    )

    text = (
        text.replace("đ", "d")
        .replace("Đ", "d")
        .lower()
    )

    text = re.sub(
        r"\bdanang\b",
        "da nang",
        text,
    )

    return " ".join(text.split())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[str] = mapped_column(
        String,
        primary_key=True,
    )

    name: Mapped[str] = mapped_column(String)


class Poi(Base):
    __tablename__ = "pois"

    id: Mapped[str] = mapped_column(
        String,
        primary_key=True,
    )

    name: Mapped[str] = mapped_column(String)

    category: Mapped[str] = mapped_column(
        ForeignKey("categories.id"),
        index=True,
    )

    search_text: Mapped[str] = mapped_column(Text)

    latitude: Mapped[float] = mapped_column(Float)

    longitude: Mapped[float] = mapped_column(Float)

    coordinates_valid: Mapped[bool] = mapped_column(
        Boolean,
    )

    legacy_only: Mapped[bool] = mapped_column(
        Boolean,
        index=True,
    )

    updated_at: Mapped[str] = mapped_column(String)

    payload: Mapped[dict] = mapped_column(JSON)


DB_PATH = Path(
    os.environ.get(
        "POI_DATABASE_PATH",
        str(
            Path(__file__).resolve().parent
            / "places.db"
        ),
    )
).resolve()


engine = create_engine(
    "sqlite:///" + str(DB_PATH),
    connect_args={
        "check_same_thread": False,
        "timeout": 30,
    },
)


@event.listens_for(engine, "connect")
def configure_sqlite(connection, _):
    connection.execute(
        "PRAGMA foreign_keys=ON"
    )

    connection.execute(
        "PRAGMA journal_mode=WAL"
    )


SessionLocal = sessionmaker(bind=engine)


def init_db():
    Base.metadata.create_all(engine)


def get_session():
    with SessionLocal() as session:
        yield session