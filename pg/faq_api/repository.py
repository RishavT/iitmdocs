from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from pg.faq_api.orm import Faq


@dataclass(frozen=True)
class FaqSearchRow:
    """FAQ row returned by lookup/search operations."""

    id: int
    topic_filename: Optional[str]
    question: str
    answer: str
    cosine_similarity: float


@dataclass(frozen=True)
class FaqEmbeddingInput:
    """FAQ row that needs an embedding backfill."""

    id: int
    question: str


def _to_search_row(faq: Faq, cosine_similarity: float) -> FaqSearchRow:
    return FaqSearchRow(
        id=int(faq.id),
        topic_filename=faq.topic_filename,
        question=faq.question,
        answer=faq.answer,
        cosine_similarity=float(cosine_similarity),
    )


def get_faq_by_id(session: Session, faq_id: int) -> Optional[FaqSearchRow]:
    """Fetch one FAQ by id for direct UI clickthrough."""

    faq = session.get(Faq, faq_id)
    if faq is None:
        return None
    return _to_search_row(faq, 1.0)


def search_faqs_by_embedding(
    session: Session,
    query_embedding: Sequence[float],
    limit: int,
) -> list[FaqSearchRow]:
    """Search FAQs by pgvector cosine distance using SQLAlchemy expressions."""

    distance = Faq.embedding.cosine_distance(list(query_embedding))
    cosine_similarity = (1 - distance).label("cosine_similarity")

    stmt = (
        select(Faq, cosine_similarity)
        .where(Faq.embedding.is_not(None))
        .order_by(distance)
        .limit(limit)
    )

    results: list[FaqSearchRow] = []
    for faq, similarity in session.execute(stmt):
        results.append(_to_search_row(faq, similarity))
    return results


def replace_seed_faqs(session: Session, rows: Sequence[dict]) -> int:
    """Replace all FAQ rows with the seed FAQ rows."""

    session.execute(delete(Faq))

    session.add_all(
        Faq(
            topic_filename=row["topic_filename"],
            question=row["question"],
            answer=row["answer"],
            source_url=row.get("source_url"),
        )
        for row in rows
    )
    return len(rows)


def get_faqs_missing_embeddings(session: Session, limit: int) -> list[FaqEmbeddingInput]:
    """Return a deterministic batch of FAQ rows that still need embeddings."""

    stmt = (
        select(Faq.id, Faq.question)
        .where(Faq.embedding.is_(None))
        .order_by(Faq.id)
        .limit(limit)
    )
    return [FaqEmbeddingInput(id=int(row.id), question=row.question) for row in session.execute(stmt)]


def update_faq_embedding(session: Session, faq_id: int, embedding: Sequence[float]) -> None:
    """Update one FAQ embedding."""

    faq = session.get(Faq, faq_id)
    if faq is None:
        return
    faq.embedding = list(embedding)


def count_faqs(session: Session) -> int:
    """Count FAQ rows."""

    return int(session.query(Faq).count())


def count_faqs_missing_embeddings(session: Session) -> int:
    """Count FAQ rows whose embedding still needs backfill."""

    return int(session.query(Faq).filter(Faq.embedding.is_(None)).count())
