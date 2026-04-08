SELECT
    id,
    topic_filename,
    question,
    answer,
    1 - (embedding <=> $1::vector) AS cosine_similarity
  FROM faqs
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> $1::vector
  LIMIT 5;