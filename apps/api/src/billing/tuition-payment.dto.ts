import { Allow } from 'class-validator';

/** 0240 tuition payment commands. Every field is closed-validated by the shared contract validators in the service. */
export class RecordTuitionPaymentDto {
  @Allow() expectedInvoiceVersion?: unknown;
  @Allow() amountMinor?: unknown;
  @Allow() currency?: unknown;
  @Allow() receivedOn?: unknown;
  @Allow() method?: unknown;
  @Allow() reference?: unknown;
  @Allow() note?: unknown;
}

export class VoidTuitionPaymentDto {
  @Allow() expectedInvoiceVersion?: unknown;
  @Allow() reason?: unknown;
}
