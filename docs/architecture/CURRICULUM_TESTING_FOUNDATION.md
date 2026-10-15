# HON Curriculum, Rank, and Testing Foundation

The curriculum foundation is deliberately **school-defined**. A school can choose a linear, rotational, hybrid, skill-based, module-based, attendance-plus-approval, or custom model. A curriculum rank separates `exposure_requirement`, `mastery_requirement`, and `promotion_requirement`; a requirement can represent technique, knowledge, character, attendance, practice, instructor judgment, or a custom definition.

## Instructor authority is not optional

Testing candidate result and promotion are distinct. A `PASSED` testing candidate does **not** mutate the student’s current rank. Every prospective promotion has its own `promotion_decisions` record, begins in `PENDING_INSTRUCTOR_DECISION`, requires a named instructor principal/rationale/time for `PROMOTED`, and will be exposed only by a human-only `testing.promotion.decide` action. No AI employee, automation, model fallback, testing attendance, rank requirement calculation, or payment outcome can directly promote a student.

## Data and scope

`curricula`, rank/requirement definitions, student curriculum enrollments, testing events/candidates, and promotion decisions all carry organization/school ownership, composite foreign keys, forced RLS, and the standard tenant policy. They are source records for later Family/Student Journey, scheduling eligibility, testing registration/payment, certificates/belts, reporting, and parent notifications. They do not become a second student or membership identity model.

## Next vertical slice

The next curriculum API will provide human instructor-only commands to create/publish a curriculum, manage ranks/requirements, enroll a student, create a testing event/candidate, record instructor evaluation, and explicitly decide promotion. Each consequential command will add idempotency, audit, versioned outbox events, and server-side permission checks through the same standard HON command path.
