from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime
from typing import Iterator, Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, Text, create_engine, func
from sqlalchemy.engine import URL, Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


class Base(DeclarativeBase):
    """Base class for PG FAQ ORM models."""


class Faq(Base):
    """ORM model for the Postgres `faqs` table."""

    __tablename__ = "faqs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    topic_filename: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    source_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
    embedding: Mapped[Optional[list[float]]] = mapped_column(Vector(1024), nullable=True)


def database_url_from_env() -> URL:
    """Build a SQLAlchemy database URL from the existing PG* environment variables."""

    query: dict[str, str] = {}
    sslmode = os.getenv("PGSSLMODE")
    connect_timeout = os.getenv("PGCONNECT_TIMEOUT")
    if sslmode:
        query["sslmode"] = sslmode
    if connect_timeout:
        query["connect_timeout"] = connect_timeout

    return URL.create(
        "postgresql+psycopg",
        username=os.getenv("PGUSER", "faq_user"),
        password=os.getenv("PGPASSWORD", "faq_password"),
        host=os.getenv("PGHOST", "postgres"),
        port=int(os.getenv("PGPORT", "5432")),
        database=os.getenv("PGDATABASE", "faqdb"),
        query=query,
    )


def create_pg_engine() -> Engine:
    """Create a SQLAlchemy engine for the FAQ Postgres database."""

    return create_engine(database_url_from_env(), pool_pre_ping=True)


def create_session_factory(engine: Engine) -> sessionmaker[Session]:
    """Create a session factory bound to the FAQ database engine."""

    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@contextmanager
def session_scope(session_factory: sessionmaker[Session]) -> Iterator[Session]:
    """Provide a transactional SQLAlchemy session scope."""

    session = session_factory()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
