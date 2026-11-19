import { Allow } from 'class-validator';

/** SI1 (0558) simple invoice command. Every field is closed-validated by the shared contract validator in the service. */
export class CreateSimpleInvoiceDto {
  @Allow() billingAccountId?: unknown;
  @Allow() dueDate?: unknown;
  @Allow() items?: unknown;
  @Allow() issue?: unknown;
  @Allow() payToPhone?: unknown;
  @Allow() payToEmail?: unknown;
  @Allow() otherWaysToPay?: unknown;
  @Allow() note?: unknown;
}
