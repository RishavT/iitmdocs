# Change-to-File Mapping: v2 → v3 Qualifier Handbook

This document maps each identified change from `comparision-result-2.md` to the specific src/ file(s) where the update should be made.

---

## Change 1: Program-specific support emails re-added

**File**: `src/contact_and_support_information.md`

**Rationale**: This file already has a "Primary Support Email" section with `support@study.iitm.ac.in`. The program-specific emails (ES, AE, MG) need to be added here since this is the dedicated contact/support file.

**What to update**: Add program-specific support emails:
- DS: support@study.iitm.ac.in
- ES: support-es@study.iitm.ac.in
- AE: support-ae@study.iitm.ac.in
- MG: support-mg@study.iitm.ac.in

---

## Change 2: "Cannot apply for multiple programs simultaneously" note

**File**: `src/about_iitm_bs_program.md`

**Rationale**: This note appears right after the list of 4 programs in the "About the program" section. The `about_iitm_bs_program.md` file has a "Programs Offered" section which is the natural fit.

**What to update**: Add a note under the Programs Offered section: "A student cannot apply for multiple programs simultaneously."

---

## Change 3: DS diploma names made explicit

**File**: `src/about_iitm_bs_program.md`

**Rationale**: The exit points / certificates for each program are listed in this file under "Programme Levels and Exit Points > BS in Data Science and Applications". The diploma names need to be updated here.

**What to update**: Change "Diploma(s) from IIT Madras" under BS in Data Science to "Diploma in Data Science from IIT Madras, Diploma in Programming from IIT Madras".

---

## Change 4: Eligibility restructuring (qualifier vs foundation) + NIOS pathway

**File**: `src/qualifier_eligibility.md`

**Rationale**: This is the dedicated eligibility file. The restructured eligibility criteria (split into "apply for qualifier" and "proceed to foundation") and the new NIOS pathway for ES/AE all belong here.

**What to update**:
- Restructure the eligibility section to separate "Eligibility to apply for qualifier" from "Eligibility to proceed from qualifier to Foundation level"
- Add NIOS pathway for ES/AE: students who passed Class 12 without Physics/Mathematics but passed these subjects through NIOS or equivalent can apply after committee approval
- Remove the statement "There are no additional eligibility criteria to apply for the Qualifier Exam or to join the Foundation Level after clearing it"
- Add DS and MG admission page links in the Foundation level eligibility section

---

## Change 5: Qualifier score validity update

**File**: `src/qualifier_results_and_validity.md`

**Rationale**: This file already has a "Qualifier Score Validity" section. The specific exam dates, updated wording, and the new Class XII dual-condition rule all fit here.

**What to update**:
- Update the validity description wording
- Add specific exam date examples for Jan2026 and May2026 terms
- Update Class XII student validity rule to: "3 terms after passing Class 12th exam, OR 6 terms after the qualifier exam date — whichever is earlier"

---

## Change 6: JEE 2024 no longer valid for May 2026 term

**File**: `src/jee_based_entry.md`

**Rationale**: This file covers JEE-based entry and already lists which JEE years are eligible for which terms. The strikethrough of 2024 for May 2026 needs to be reflected here.

**What to update**:
- Update the May 2026 JEE eligibility to remove 2024 (only 2025 and 2026 are valid)
- Update any FAQs or examples that reference JEE 2024 being valid for May 2026

---

## Change 7: Course registration restructured (same-term vs subsequent-term)

**Primary File**: `src/course_registration_process.md`

**Rationale**: This is the dedicated course registration file. The distinction between same-term and subsequent-term registration belongs here.

**What to update**:
- Add information about studying courses from week 5 while waiting for results
- Clarify that for same-term registration, qualifier score = Quiz 1 score
- Add new "Subsequent Term Registration" section with:
  - Must verify qualifier validity in Admission Letter on Student Dashboard
  - Check academic calendar for registration dates
  - Max 4 courses per term
  - Must submit assignments from week-1
  - Must appear for Quiz 1 (qualifier score NOT counted as Quiz 1)
- Reference eligibility section 1.1.1 for foundation level registration

**Secondary File**: `src/academic_level_progression_and_rules.md`

**Rationale**: The re-added progression details (114 credits for BSc in DS, AE/MG/ES progression rules) belong in the level progression file.

**What to update**:
- Add/confirm: "Students who complete 114 credits and satisfy minimum credits completion requirement will be eligible for BSc degree and can continue to BS level for Data Science and Applications program"
- Add/confirm: "For BS in AE/MG/ES - Students who successfully complete all courses and labs in Foundation and Diploma can proceed to BS Degree Level"

---

## File Impact Summary

| src/ File | Changes to Apply |
|-----------|-----------------|
| `contact_and_support_information.md` | Add program-specific support emails |
| `about_iitm_bs_program.md` | Add "cannot apply to multiple programs" note; update DS diploma names |
| `qualifier_eligibility.md` | Restructure eligibility (qualifier vs foundation); add NIOS pathway; remove "no additional criteria" statement |
| `qualifier_results_and_validity.md` | Update validity wording and examples; update Class XII rule |
| `jee_based_entry.md` | Remove JEE 2024 from May 2026 eligibility |
| `course_registration_process.md` | Add same-term vs subsequent-term distinction; Quiz 1 score rules |
| `academic_level_progression_and_rules.md` | Add/confirm program-specific progression details |

---

## Tags Update: Keywords Added to Each src/ File

All 19 src/ files were reviewed and updated with additional keywords to improve RAG retrieval. Below are the keywords added to each file.

### 1. `about_iitm_bs_program.md`
**Added**: BS electronic systems, BS management and data science, BS aeronautics and space technology, multiple exit points, foundation certificate, IITM CODE, diploma from IIT Madras, BSc degree, PGD, MTech, Diploma in Data Science, Diploma in Programming, cannot apply multiple programs, BTech vs BS, hybrid online in-person exams, four year programme, programs offered

### 2. `academic_level_progression_and_rules.md`
**Added**: U grade, unsatisfactory grade, course re-registration, prerequisites, CGPA impact, credit requirements, 114 credits BSc, 142 credits BS, foundation 32 credits, cannot take courses across levels, course access revocation, re-registration fee, 3 terms per year, minimum 4 years, AE MG ES progression, diploma to degree

### 3. `academic_structure_and_exams.md`
**Added**: OPPE, online proctored programming exam, 16 week term, incomplete grade, I grade, make-up examination, academic calendar, refund policy, non-refundable fees, quiz dates, term structure, certificates, marksheets

### 4. `bs_electronic_systems_program.md`
**Added**: physics and mathematics class 12, qualifier subjects ES, Electronic Systems Thinking and Circuits, Introduction to C Programming, cannot switch programs, ES registration, ES website, four year BS ES

### 5. `contact_and_support_information.md`
**Added**: program-specific email, support-es, support-ae, support-mg, qualifier support email, global entry email, phone number, ICSR building office address, payment issues, document upload problems, category change, hall ticket issues, special accommodation, PwD scribe request

### 6. `course_registration_process.md`
**Added**: select exam cities, maximum 4 courses per term, online payment only, qualifier score as Quiz 1, same term registration, subsequent term registration, week 5 continuation, defer joining, CCC credit clearing capability, foundation courses, Rs 6000 per course, class 12 documentation upload, U grade re-registration, cannot register across levels, exam city list, Quiz 1 mandatory subsequent term

### 7. `fees_and_payments.md`
**Added**: qualifier application fee, reattempt fee, non-refundable, category wise fees, SC ST PwD fee, OBC fee, international exam facilitation fee, fee waiver, income based fee waiver, income certificate, no EMI option, no cheque payment, online payment portal, credit based pricing

### 8. `independent_faqs.md`
**Added**: laptop not provided, no VPN access, English language, no hostel, no library, no campus facilities, campus visit, IST exam timings, student ID card, student email, application online only, payment online only, SCT system compatibility test, recorded lectures, clearing doubts, discussion forums, Gen AI theory project

### 9. `international_students_information.md`
**Added**: remote proctored exam, no travel to India, exam timing IST, Rs 2000 facilitation fee per subject, residence proof, ID proof, residence card, driving license, bank statement, utility bill, visa page, citizenship document, global entry email, ge@study.iitm.ac.in, exam city availability abroad

### 10. `jee_based_entry.md`
**Added**: regular entry vs JEE entry, two entry pathways, CCC credit clearing capability of 4, skip qualifier, direct foundation admission, JEE proof upload, JEE Main scorecard, JEE Advanced admit card, cannot switch entry type, international exams not accepted, SAT AP IB A-Levels not accepted, JEE 2024 2025 2026 eligibility, admission cycles, 3 terms validity

### 11. `paradox_event.md`
**Added**: annual offline event, May June event, valid student ID required, qualifier cleared students eligible, paradox dates

### 12. `placements.md`
**Added**: placement portal, minimum diploma level required, CGPA not guaranteed for placements, BS electronic systems placement, same placement portal all programs

### 13. `qualifier_assignments_and_cutoff.md`
**Added**: graded out of 100, not attempted zero, general 40 percent, OBC-NCL EWS 35 percent, SC ST PwD 30 percent, first 2 weeks average, best 2 out of 3 weeks, hall ticket eligibility, relaxations only qualifier, category documents, OBC-NCL certificate, cannot change category, assignments compulsory

### 14. `qualifier_eligibility.md`
**Added**: NIOS pathway, committee approval ES AE, apply for qualifier, proceed to foundation level, class 10 maths english, class 12 physics mathematics, cannot apply multiple programs, class 11 students eligible, DS MG eligibility, ES AE eligibility, accepted class 12 equivalents, commerce arts students, diploma holders eligibility, no age restriction, foundation level registration eligibility

### 15. `qualifier_exam_format_and_centers.md`
**Added**: select 2 cities per term, 4 hours 240 minutes duration, in-person India, remote proctored international, all 4 subjects same day, MCQ MSQ numerical short answer, no negative marking, calculator enabled, closed book exam, hall ticket mandatory, valid ID proof Aadhaar PAN passport, 9 AM IST 2 PM IST slots, cannot write from home India, exam city edit window, special accommodation PwD scribe, not conducted at IIT Madras campus

### 16. `qualifier_exam_overview.md`
**Added**: 4 week process, week wise content release, videos tutorials assignments transcripts, weekly graded assignment, week 1 sample content, qualifier subjects DS MG, English 1 Maths-1 Statistics-1 Computational Thinking, qualifier subjects ES AE, Electronic Systems Thinking and Circuits Introduction to C Programming, qualifying exam not competitive, subject wise cutoff, 10 hours per week per course, self study sufficient, no coaching required, moderately difficult, easier than regular term exams

### 17. `qualifier_reattempts.md`
**Added**: two attempts per term, end of 4 weeks first attempt, end of 8 weeks second attempt, absent candidates reattempt, failed candidates reattempt, no repeat assignments same term, reattempt fee Rs 2000 1000 500, unlimited attempts across terms, fresh application new term, redo coursework new term, cannot improve marks if passed, same difficulty reattempt, failing does not affect future admissions

### 18. `qualifier_results_and_validity.md`
**Added**: email WhatsApp portal notification, admission letter, marks on portal, 3 terms validity, invalid 4th term onwards, class 12 validity 3 terms or 6 terms whichever earlier, cannot reattempt during validity, first attempt same term registration, qualifier score as Quiz 1, second attempt subsequent term, results on dashboard, validity expires automatically, cannot extend validity, program choice locked after clearing, registration not automatic, delay registration within validity

### 19. `working_professionals_and_parallel_study.md`
**Added**: no special approval needed, 10 hours per week per course, pre-recorded video lectures, YouTube accessible, learn at own pace, in-person exam mandatory, select convenient exam cities, can defer 3 terms, can pursue alongside another degree, self study materials, no coaching needed, student communities peer support

---

## KNOWLEDGE_BASE_SUMMARY Curation (worker.js)

### Why fewer keywords in KNOWLEDGE_BASE_SUMMARY vs src/ file tags?

The tags in `src/*.md` and the keywords in `KNOWLEDGE_BASE_SUMMARY` serve **different consumers** and therefore need different strategies:

| | Tags in `src/*.md` files | `KNOWLEDGE_BASE_SUMMARY` in worker.js |
|---|---|---|
| **Read by** | Weaviate vector DB (bge-m3 embeddings + BM25 keyword search) | gpt-4o-mini (query rewriting LLM) |
| **Purpose** | Help hybrid search find the right document chunk | Help the LLM understand what topics exist so it picks 3-5 keywords to append to user query |
| **Search mechanism** | BM25 does exact keyword matching — more keywords = more chances of a match = better recall | LLM reads the full summary as context — it needs to *differentiate* topics, not match keywords |
| **More keywords → ?** | Better BM25 recall (beneficial) | Higher token cost per query + blurred topic boundaries → LLM may add keywords matching multiple topics → worse retrieval precision |

**Key reasoning:**

1. **bge-m3 handles semantics, gpt-4o-mini handles routing.** The embedding model (bge-m3) in hybrid search already captures semantic similarity. The query rewriter's job is just to add a few discriminating keywords that help route the query to the right *topic*. It doesn't need 30 keywords per topic to do this.

2. **Discrimination > Coverage.** In KNOWLEDGE_BASE_SUMMARY, keywords should help distinguish topic 8 (Qualifier Eligibility) from topic 9 (Qualifier Assignments) from topic 10 (Qualifier Results). If all three share keywords like "qualifier", "eligibility", "class 12", the rewriter can't distinguish them. Unique keywords like "NIOS pathway" (topic 8), "hall ticket eligibility" (topic 9), "admission letter" (topic 10) are far more useful.

3. **Token cost.** KNOWLEDGE_BASE_SUMMARY is included in the system prompt for *every single query rewrite call*. Going from ~500 tokens to ~1500 tokens triples the input cost on that call with diminishing returns.

4. **gpt-4o-mini context window quality.** Smaller, focused context leads to better LLM decisions. A wall of 30+ keywords per topic makes the model's job harder, not easier.

### Curated keywords per topic (8-12 per topic, high-discrimination)

The following curated keywords were chosen for `KNOWLEDGE_BASE_SUMMARY` in `worker.js`. Each keyword was selected for its ability to **uniquely identify** the topic and differentiate it from similar topics.

| # | Topic | Curated Keywords | Discrimination rationale |
|---|-------|-----------------|------------------------|
| 1 | About IIT Madras BS Program | program overview, four BS programmes, exit points (certificate/diploma/BSc/BS/MTech), online learning, BTech vs BS, degree validity, cannot apply multiple programs | "Exit points" and "four programmes" distinguish from academic structure. "BTech vs BS" is a unique FAQ. |
| 2 | Academic Structure and Exams | term structure (16 weeks), quiz/end-term pattern, OPPE, grading weightage, I grade incomplete, make-up examination, academic calendar | "OPPE", "I grade", "16 weeks" are unique to this topic. Avoids generic "exam" which appears everywhere. |
| 3 | Academic Level Progression | level progression (Foundation→Diploma→Degree), credit requirements (114/142), U grade re-registration, cannot take courses across levels, course access revocation | Credit numbers and "U grade" are unique anchors. "Cross-level" restriction is only here. |
| 4 | Course Registration Process | registration steps, exam cities, same-term vs subsequent-term, qualifier score as Quiz 1, max 4 courses, defer joining, prerequisites | "Same-term vs subsequent-term" and "Quiz 1 score" are new v3 additions unique to this topic. |
| 5 | Fees and Payments | fee structure, qualifier application fee, reattempt fee, category-wise fees, fee waiver, refund policy, international facilitation fee, online payment | Specific fee types distinguish from other topics that mention fees in passing. |
| 6 | JEE Based Entry | JEE Advanced direct admission, skip qualifier, CCC of 4, JEE proof upload, which JEE years valid, cannot switch entry type, SAT/AP/IB not accepted | "CCC of 4", "skip qualifier", "cannot switch" are unique to JEE route. |
| 7 | Qualifier Exam Overview | 4-week process, qualifier subjects (DS/MG vs ES/AE), week-wise content, preparation difficulty, self-study, 10 hours per week | "4-week process" and subject lists differentiate from format/eligibility/results topics. |
| 8 | Qualifier Eligibility | who can apply, Class 10 Maths/English, Class 12 Physics/Maths, NIOS pathway, two-stage eligibility, Class 11 students | "NIOS", "two-stage eligibility", specific subject requirements are unique anchors. |
| 9 | Qualifier Assignments and Cutoff | scores graded out of 100, category-wise cutoff (40%/35%/30%), first 2 weeks average, best 2 of 3, hall ticket eligibility | Specific percentages and "hall ticket eligibility" distinguish from results/reattempts. |
| 10 | Qualifier Results and Validity | score validity (3 terms), Class 12 validity (3 terms or 6 terms), admission letter, Quiz 1 same term, program choice locked | "3 terms or 6 terms", "admission letter", "program choice locked" are unique to this topic. |
| 11 | Qualifier Reattempts | second attempt same term, reattempt fee, absent/failed reattempt, no repeat assignments, unlimited attempts across terms | "No repeat assignments", "unlimited across terms" distinguish from eligibility/results. |
| 12 | Qualifier Exam Format and Centers | exam cities (select 2), 4 hours duration, MCQ/MSQ/numerical, in-person India / remote international, hall ticket, no negative marking, calculator | Physical exam logistics — format, duration, documents — unique to this topic. |
| 13 | Working Professionals | job alongside degree, flexible schedule, pre-recorded lectures, 10 hours/week, no special approval, in-person exam mandatory, defer 3 terms | "No special approval", "job alongside" clearly target working professional queries. |
| 14 | International Students | remote proctored exam, Rs 2000 facilitation fee, IST timing, residence/ID proof, global entry email, exam city abroad | "Remote proctored", "facilitation fee", "IST timing" are unique to international context. |
| 15 | Placements | placement portal, minimum diploma level, salary and companies, internship, same portal all programs | "Minimum diploma level" and "portal" distinguish from general program info. |
| 16 | BS Electronic Systems | ES program details, difference from DS, Physics/Maths required, ES qualifier subjects, cannot switch programs | ES-specific subjects and "difference from DS" are the key discriminators. |
| 17 | Contact and Support | program-specific emails (DS/ES/AE/MG), phone number, office address, PwD accommodation | Contact-specific terms clearly route support queries here. |
| 18 | Paradox Event | annual offline event, May-June, student ID required | Very narrow topic — minimal keywords are sufficient. |
| 19 | Independent FAQs | laptop/hostel/VPN not provided, campus visit, student ID issuance, SCT test, recorded lectures, online-only | Miscellaneous terms that don't fit other topics — acts as a catch-all. |
