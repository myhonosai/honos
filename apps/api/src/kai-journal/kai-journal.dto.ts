import { Allow } from 'class-validator';

/** 0476 journal entry save. Every field is closed-validated by the shared contract validator in the service. */
export class SaveKaiJournalEntryDto {
  @Allow() entryId?: unknown;
  @Allow() expectedVersion?: unknown;
  @Allow() taughtOn?: unknown;
  @Allow() className?: unknown;
  @Allow() notes?: unknown;
  @Allow() topics?: unknown;
  @Allow() source?: unknown;
  @Allow() status?: unknown;
  @Allow() shared?: unknown;
}
