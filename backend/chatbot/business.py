"""
Pure business logic ported 1:1 from worker.js.

Every constant string, regex, and threshold here is a faithful port of the
Cloudflare Worker so client-visible behaviour is unchanged. Function names are
Pythonic (snake_case) but semantics match the original exactly.
"""
from __future__ import annotations

import re
import uuid
from typing import Optional

# ============================================================================
# CONFIGURATION
# ============================================================================
# worker.js hardcodes `const ENABLE_HISTORY = false;`. Kept env-overridable but
# defaults False so each message is treated as a new conversation.
import os


def enable_history() -> bool:
    raw = os.getenv("ENABLE_HISTORY")
    if raw is None:
        return False
    return raw.strip().lower() in ("1", "true", "yes", "on")


def generate_uuid() -> str:
    """UUID v4 for conversation tracking (worker: crypto.randomUUID())."""
    return str(uuid.uuid4())


# ============================================================================
# VALIDATION HELPERS
# ============================================================================
OUT_OF_SCOPE_KEYWORDS = [
    "capital", "country", "cook", "recipe", "weather", "sports",
    "movie", "music", "celebrity", "politics", "quantum physics",
    "fix.*car", "lose.*weight", "stock market", "cryptocurrency",
    "world cup", "pizza", "guitar", "hack",
]


def is_likely_out_of_scope(question: str) -> bool:
    question_lower = question.lower()
    return any(re.search(rf"\b{keyword}", question_lower, re.IGNORECASE) for keyword in OUT_OF_SCOPE_KEYWORDS)


# ============================================================================
# LANGUAGE SUPPORT
# ============================================================================
SUPPORTED_LANGUAGES = ["english", "hindi", "tamil", "hinglish"]

# Single source of truth for contact info.
CONTACT_INFO = {
    "email": "support@study.iitm.ac.in",
    "phone": "7850999966",
}

# Kept for parity with the Worker (django-cors-headers applies the real headers).
CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

CANNOT_ANSWER_MESSAGES = {
    "english": (
        "I'm sorry, I don't have the information to answer that question right now. "
        "Please rephrase your question and try again. Please refer to the official IITM BS degree "
        "program website or contact support for more details. If this is an error - please report "
        "this response using the feedback option. You can reach out to us at "
        f"{CONTACT_INFO['email']} or call us at {CONTACT_INFO['phone']}"
    ),
    "hindi": (
        "मुझे खेद है, मेरे पास अभी इस प्रश्न का उत्तर देने की जानकारी नहीं है। कृपया अपना प्रश्न दोबारा लिखें और पुनः "
        "प्रयास करें। अधिक जानकारी के लिए कृपया आधिकारिक IITM BS डिग्री प्रोग्राम वेबसाइट देखें या सहायता से संपर्क करें। "
        "यदि यह कोई त्रुटि है - तो कृपया फीडबैक विकल्प का उपयोग करके इस प्रतिक्रिया की रिपोर्ट करें। आप हमसे "
        f"{CONTACT_INFO['email']} पर संपर्क कर सकते हैं या {CONTACT_INFO['phone']} पर कॉल कर सकते हैं"
    ),
    "tamil": (
        "மன்னிக்கவும், இந்த கேள்விக்கு பதிலளிக்க என்னிடம் தற்போது தகவல் இல்லை. உங்கள் கேள்வியை மீண்டும் எழுதி "
        "முயற்சிக்கவும். மேலும் விவரங்களுக்கு அதிகாரப்பூர்வ IITM BS டிகிரி புரோகிராம் இணையதளத்தைப் பார்க்கவும் அல்லது "
        "ஆதரவைத் தொடர்பு கொள்ளவும். இது ஒரு பிழை என்றால் - பின்னூட்ட விருப்பத்தைப் பயன்படுத்தி இந்த பதிலைப் "
        f"புகாரளிக்கவும். நீங்கள் எங்களை {CONTACT_INFO['email']} இல் தொடர்பு கொள்ளலாம் அல்லது {CONTACT_INFO['phone']} "
        "என்ற எண்ணில் அழைக்கலாம்"
    ),
    "hinglish": (
        "Maaf kijiye, mere paas abhi is sawaal ka jawaab dene ki jaankari nahi hai. Kripya apna sawaal dobara "
        "likhein aur phir se try karein. Zyada jaankari ke liye kripya official IITM BS degree program website "
        "dekhein ya support se sampark karein. Agar yeh koi galti hai - toh kripya feedback option use karke is "
        f"response ki report karein. Aap humse {CONTACT_INFO['email']} par sampark kar sakte hain ya "
        f"{CONTACT_INFO['phone']} par call kar sakte hain"
    ),
}

STANDARD_RAAHAT_MESSAGE = """I'm afraid I am not allowed to give you advice of any kind, but we are here. If you're looking for mental health support, our institute has a Wellness Society that provides confidential counseling services to enrolled students.

📧 Reach out to them at: wellness.society@study.iitm.ac.in
📱 Instagram: @wellness.society_iitmbs

If you are not enrolled in our program yet, but need someone to talk to, please consider reaching out to a local mental health professional or helpline in your area. Some organizations that offer support in India include:

- Aasra - https://www.aasra.info/
- Sneha - https://snehaindia.org/new/

Please don't hesitate to contact them - that's what they're there for. You're not alone in this."""


def extract_language(rewritten_query: Optional[str]) -> str:
    """worker.js currently always returns 'english' (language detection disabled)."""
    return "english"


def get_cannot_answer_message(language: Optional[str]) -> str:
    lang = (language or "english").lower()
    return CANNOT_ANSWER_MESSAGES.get(lang, CANNOT_ANSWER_MESSAGES["english"])


def is_cannot_answer_response(text: Optional[str]) -> bool:
    normalized = re.sub(r"\s+", " ", (text or "").lower()).strip()
    if not normalized:
        return False
    if "don't have the information to answer" in normalized:
        return True
    if "please rephrase your question" in normalized:
        return True

    # Check whether the response starts like any standard "cannot answer" message.
    for message in CANNOT_ANSWER_MESSAGES.values():
        prefix = re.sub(r"\s+", " ", message.lower()).strip()[:80]
        if prefix and prefix in normalized:
            return True
    return False


# ============================================================================
# PROMPT INJECTION PROTECTION
# ============================================================================
INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)", re.IGNORECASE),
    re.compile(r"disregard\s+(all\s+)?(previous|above|prior)", re.IGNORECASE),
    re.compile(r"forget\s+(everything|all|what)", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+a?", re.IGNORECASE),
    re.compile(r"pretend\s+(you\s+are|to\s+be)", re.IGNORECASE),
    re.compile(r"act\s+as\s+(if|a)", re.IGNORECASE),
    re.compile(r"new\s+instructions?:", re.IGNORECASE),
    re.compile(r"system\s*:", re.IGNORECASE),
    re.compile(r"assistant\s*:", re.IGNORECASE),
    re.compile(r"\[system\]", re.IGNORECASE),
    re.compile(r"\[assistant\]", re.IGNORECASE),
    re.compile(r"<system>", re.IGNORECASE),
    re.compile(r"</system>", re.IGNORECASE),
]

MAX_QUERY_LENGTH = 500


def sanitize_query(query) -> str:
    """Strip injection patterns + cap length. Non-string/empty -> ''."""
    if not query or not isinstance(query, str):
        return ""
    sanitized = query[:MAX_QUERY_LENGTH]
    for pattern in INJECTION_PATTERNS:
        sanitized = pattern.sub("", sanitized)
    sanitized = re.sub(r"\s+", " ", sanitized).strip()
    return sanitized


# ============================================================================
# QUERY SYNONYMS
# ============================================================================
QUERY_SYNONYMS = [
    (["grading policy", "grading formula", "grade calculation", "how is grade calculated", "marks distribution", "score calculation"],
     "grading formula score calculation GAA quiz end term OPPE weightage"),
    (["pdsa grading", "pdsa marks", "pdsa score"],
     "PDSA Programming Data Structures Algorithms grading formula T = 0.1GAA + 0.4F + 0.2OP quiz"),
    (["python grading", "python marks"],
     "Python programming grading formula OPPE PE1 PE2 quiz end term"),
    (["i grade", "incomplete grade", "i_op", "i_both"],
     "I grade incomplete I_OP I_BOTH absent end term OPPE fail next term"),
    (["quiz 1 syllabus", "quiz1 syllabus", "q1 syllabus"],
     "Quiz 1 syllabus weeks 1-4 content coverage"),
    (["quiz 2 syllabus", "quiz2 syllabus", "q2 syllabus"],
     "Quiz 2 Qz2 syllabus Week 5-8 Week 3-8 content coverage grading"),
    (["end term syllabus", "final exam syllabus", "et syllabus"],
     "End term exam syllabus weeks 1-12 full course content"),
    (["exam city change", "change exam center", "change quiz city", "edit exam city"],
     "exam city change registration different cities quiz end term each term"),
    (["answer review", "review answers", "see my answers", "check answers after exam"],
     "answer review exam results dashboard score release"),
    (["no quiz 1", "without quiz 1", "courses no quiz"],
     "courses without Quiz 1 Software Engineering MLP BDM TDS Big Data"),
    (["no quiz 2", "without quiz 2"],
     "courses without Quiz 2 Python Programming C MLP TDS Big Data"),
    (["3 credits", "three credits", "3 credit subjects", "which subjects 3 credits"],
     "credits per course foundation 4 credits diploma degree 4 credits NPTEL 1-3 credits"),
    (["4 credits", "four credits"],
     "4 credits foundation courses diploma courses apprenticeship"),
    (["nptel credits", "nptel transfer", "how many nptel", "nptel credit transfer"],
     "NPTEL credit transfer maximum 8 credits 4-week=1 8-week=2 12-week=3 Rs 1000 per credit"),
    (["campus credits", "iitm campus courses"],
     "campus courses credit transfer maximum 24 credits CGPA 8.0 Rs 2500 per credit"),
    (["diploma data science courses", "ds diploma courses", "data science diploma subjects"],
     "Diploma Data Science courses MLF MLT MLP BDM BA TDS Machine Learning Business"),
    (["diploma programming courses", "dp diploma courses", "programming diploma subjects"],
     "Diploma Programming courses DBMS PDSA Java System Commands AppDev1 AppDev2"),
    (["foundation courses", "foundation subjects", "year 1 courses"],
     "Foundation courses Maths 1 2 Statistics 1 2 English 1 2 Python Computational Thinking"),
    (["degree courses", "bsc courses", "bs courses"],
     "Degree level courses Software Engineering Testing AI Deep Learning electives"),
    (["core pairs", "mandatory pairs"],
     "core pairs Software Engineering Testing AI Search Deep Learning degree level"),
    (["prerequisites", "prereq", "pre-requisite"],
     "prerequisites course requirements Maths Statistics English Python foundation diploma"),
    (["registration date", "important dates", "academic calendar", "term start", "term dates", "registration deadline"],
     "registration dates academic calendar term start important dates admissions timeline course registration deadline"),
    (["direct entry", "dad", "direct admission diploma", "skip foundation"],
     "Direct Admission Diploma DAD 2 years UG qualifier exam Rs 6000"),
    (["jee entry", "jee admission", "jee advanced"],
     "JEE Advanced direct entry foundation level skip qualifier"),
    (["eligibility", "who can apply", "qualification required"],
     "eligibility Class 12 passed Mathematics English Class 10 any age any stream"),
    (["qualifier exam", "qualifier process", "how to qualify"],
     "qualifier exam 4 weeks preparation Rs 4000 fee application process"),
    (["fee waiver", "scholarship", "fee reduction", "concession"],
     "fee waiver SC ST PwD OBC-NCL EWS income 50% 75% waiver"),
    (["fee waiver documents", "documents for waiver", "waiver proof"],
     "fee waiver documents category certificate income certificate PwD certificate"),
    (["army fee waiver", "defense fee waiver", "military fee waiver"],
     "fee waiver army defense General category income based EWS 50% 75% waiver"),
    (["total fee", "programme fee", "course fee", "how much fee"],
     "fee structure Foundation Rs 32000 Diploma Rs 62500 BSc Rs 2.21L BS Rs 3.86L"),
    (["international fee", "foreign student fee", "outside india fee"],
     "international students facilitation fee Quiz Rs 2000 End Term Rs 2000-4000"),
    (["hard copy certificate", "original certificate", "physical certificate"],
     "original certificate hard copy alumni registration Rs 6000 exit form processing"),
    (["transcript", "mark sheet", "grade card"],
     "transcript academic record grades courses completed CGPA"),
    (["oppe", "online proctored", "programming exam"],
     "OPPE Online Proctored Programming Exam remote proctored coding"),
    (["sct", "system compatibility", "compatibility test"],
     "SCT System Compatibility Test mandatory before OPPE camera microphone check"),
    (["placement eligibility", "when placement", "eligible for placement"],
     "placement eligibility internship after 1 diploma job after BSc degree"),
    (["average salary", "placement salary", "package"],
     "placement salary average Rs 10 LPA highest Rs 25 LPA internship Rs 30000"),
    (["companies", "recruiters", "which companies"],
     "recruiters Amazon Microsoft Deloitte Wipro TCS companies placement"),
    (["repeat course", "fail course", "retake"],
     "repeat course fail full fee again all assessments next term"),
    (["probation", "struck off", "removed"],
     "academic probation 2 terms struck off 3 terms without registration readmission"),
    (["chatgpt", "llm", "ai help", "plagiarism"],
     "LLM ChatGPT plagiarism honor code violation not allowed assignments"),
    (["masters", "mtech", "ms", "phd", "higher studies"],
     "Masters MTech MS PhD GATE CFTI route CGPA 8.0 research campus upgrade"),
]

# Compile each synonym into a case-insensitive whole-word regex for query matching.
# For example: "Can you explain the grading policy?" can be rewritten using the canonical query: "grading formula score calculation GAA quiz end term OPPE weightage"
COMPILED_SYNONYMS = [
    ([re.compile(rf"\b{re.escape(p)}\b", re.IGNORECASE) for p in patterns], canonical)
    for patterns, canonical in QUERY_SYNONYMS
]

# Condensed knowledge base summary used as query-rewriting context.
KNOWLEDGE_BASE_SUMMARY = """Topics available in knowledge base:
1. About IIT Madras BS Program: program overview, four BS programmes (DS, ES, MG, AE), online learning with in-person exams, programme levels, exit points, certificates and degrees, official website and contact details
2. JEE-Based Entry: admission pathways, direct entry using JEE Advanced eligibility, validity period, application process, proof upload, benefits like skipping qualifier, CCC of 4, entry type restrictions
3. Academic Level Progression and Rules: Foundation, Diploma, Degree progression, credit requirements (32, 59, 86, 114, 142, 162, 182), cannot take courses across levels, U grade, re-registration, prerequisites, CGPA impact, exit pathways
4. Qualifier Assignments and Cutoff: assignment grading rules, minimum assignment scores by category, qualifier exam cutoffs, category-wise relaxations, hall ticket eligibility, first and second attempt eligibility rules
5. Academic Structure and Exams: quizzes and end-term exams, exam structure, eligibility requirements, attendance through assignments, exam rules, refund policy, non-refundable fees, academic guidelines
6. Qualifier Eligibility: eligibility for DS, MG, ES, AE programs, Class 10 Maths and English, Class 12 requirements, Physics and Mathematics for ES/AE, Class 11 eligibility, NIOS pathway, no age restriction
7. BS in Electronic Systems Program: ES program overview, eligibility requirements, qualifier subjects, registration process, differences from Data Science, restriction on switching programs
8. Qualifier Exam Format and Centers: exam format (MCQ, MSQ, numerical, short answer), 4-hour duration, no negative marking, exam cities, in-person India exams, remote proctored international exams, required documents
9. Contact and Support Information: support emails for DS, ES, AE, MG, qualifier support, Global Entry contact, phone number, office address, when to contact support, chatbot scope and limitations
10. Qualifier Exam Overview: 4-week qualifier process, weekly content release, videos, tutorials, graded assignments, sample Week-1 access, self-paced learning structure
11. Course Registration Process: course selection steps, exam city selection, prerequisite checks, payment process, same-term and subsequent-term registration rules, maximum 4 courses, qualifier score usage
12. Qualifier Reattempts: attempts within a term, eligibility for reattempt, reattempt process, fee structure by category, assignment carry-forward rules, reattempt in future terms
13. Fees and Payments: qualifier fees, reattempt fees, per-course fees, total program cost by level, online payment rules, fee waivers, international facilitation fees, refund rules
14. Qualifier Results and Validity: result communication via portal/email/WhatsApp, admission letter, validity for 3 terms, Class 12 special rule, expiry rules, registration after qualifying
15. International Students Information: eligibility for foreign students, remote proctored exams, IST timing, additional fees, required documents, payment issues, Global Entry support
16. Working Professionals and Parallel Study: studying alongside job or degree, flexible schedule, pre-recorded lectures, weekly time commitment, in-person exams, taking breaks, self-study approach
"""

STOPWORDS_TO_IGNORE = {"may", "not", "no", "only", "free", "all"}

STOPWORDS = {
    "a", "an", "the",
    "i", "me", "my", "we", "our", "you", "your", "it", "its",
    "is", "are", "was", "were", "am", "be", "been", "being",
    "do", "does", "did", "done",
    "will", "would", "could", "should", "shall",
    "have", "has", "had",
    "what", "where", "when", "how", "which", "who", "whom", "why",
    "this", "that", "these", "those",
    "and", "but", "or", "so",
    "to", "of", "in", "on", "at", "by", "with", "from", "as", "into", "for",
    "please", "tell", "give", "let", "know", "want", "need", "get", "got",
    "there", "here", "just", "also", "very", "if", "then", "any", "some",
}


def remove_stop_words(query: str) -> str:
    """Remove common filler words before synonym matching and retrieval.

    Words such as "the"" and "how" are removed, while important words such
    as "not" and "only" are kept. If every word would be removed, return
    the original query so the search still has useful input.

    Example: "What is the grading policy?" becomes
    "grading policy?".
    """
    words = re.split(r"\s+", query.strip())
    filtered = []
    for word in words:
        lower = re.sub(r"[?!.,]+$", "", word.lower())
        if lower in STOPWORDS_TO_IGNORE:
            filtered.append(word)
            continue
        if lower in STOPWORDS:
            continue
        filtered.append(word)
    result = " ".join(filtered).strip()
    return result if len(result) > 0 else query


def find_synonym_match(query: str) -> Optional[str]:
    for regexes, canonical_query in COMPILED_SYNONYMS:
        for regex in regexes:
            if regex.search(query):
                return canonical_query
    return None


# ============================================================================
# "DID YOU MEAN?" FAQ SUGGESTIONS
# ============================================================================
def format_db_faq_suggestions(db_faqs, language: str = "english") -> str:
    if not db_faqs:
        return ""
    did_you_mean = {
        "english": "**Did you mean:**",
        "hindi": "**क्या आपका मतलब था:**",
        "tamil": "**நீங்கள் கருதுவது:**",
        "hinglish": "**Kya aap ye poochna chahte the:**",
    }
    header = did_you_mean.get(language, did_you_mean["english"])
    suggestions = "\n".join(
        f"{i + 1}. {faq['question']} [FAQID:{faq['id']}]" for i, faq in enumerate(db_faqs[:5])
    )
    return f"\n\n{header}\n\n{suggestions}"


# ============================================================================
# RAAHAT (mental-health) content handling
# ============================================================================
def contains_raahat(text: str) -> bool:
    lower_text = (text or "").lower()
    return (
        "raahat" in lower_text
        or "wellness.society@study.iitm.ac.in" in lower_text
        or "@wellness.society_iitmbs" in lower_text
        or "mental health & wellness society" in lower_text
    )


RAAHAT_KEYWORDS = [
    "raahat",
    "wellness.society@study.iitm.ac.in",
    "@wellness.society_iitmbs",
    "mental health",
    "wellness society",
    "support is available",
    "you're not alone",
    "don't hesitate to contact",
]


def split_raahat_content(text: str) -> dict:
    if not contains_raahat(text):
        return {"raahat_chunk": "", "other_chunk": text, "has_raahat": False}

    raahat_lines = []
    other_lines = []
    for line in text.split("\n"):
        lower_line = line.lower()
        if any(keyword in lower_line for keyword in RAAHAT_KEYWORDS):
            raahat_lines.append(line)
        else:
            other_lines.append(line)

    return {
        "raahat_chunk": "\n".join(raahat_lines).strip(),
        "other_chunk": "\n".join(other_lines).strip(),
        "has_raahat": len(raahat_lines) > 0,
    }


def count_statements(text: str) -> int:
    if not text:
        return 0
    count = 0
    for line in text.split("\n"):
        trimmed = line.strip()
        if len(trimmed) > 0 and not trimmed.startswith("#") and len(trimmed) > 5:
            count += 1
    return count
