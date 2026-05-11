from __future__ import annotations

"""
SQLAlchemy model and session setup for the PG FAQ database.

This file answers: "What does the FAQ table look like to Python code, and how
do we open safe ORM sessions against Postgres?"

It intentionally does not contain product operations like "search FAQs" or
"replace seed rows". Those actions live in `repository.py`.

Keep this file in sync with `pg/init/001_faq_schema.sql`:
- the `Faq` model describes the same columns as the `faqs` table
- `embedding` must stay `Vector(1024)` while the schema uses `vector(1024)`
- connection settings come from the same `PG*` environment variables used by
  the PG FAQ API and bootstrap job
"""

import os
from contextlib import contextmanager
from typing import Iterator, Optional

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, Text, create_engine
from sqlalchemy.engine import URL, Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


class Base(DeclarativeBase):
    """Base class for PG FAQ ORM models."""


class Faq(Base):
    """ORM model for the Postgres `faqs` table."""

    __tablename__ = "faqs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    program_id: Mapped[str] = mapped_column(Text, nullable=False)
    question: Mapped[str] = mapped_column(Text, nullable=False)
    answer: Mapped[str] = mapped_column(Text, nullable=False)
    # Must stay in sync with `embedding vector(1024)` in pg/init/001_faq_schema.sql.
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
