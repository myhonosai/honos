import type { IssueInvoiceInput } from '@hon/contracts';
import { IsInt, Min } from 'class-validator';

/** Human issuance accepts only the invoice version observed by the operator. */
export class IssueInvoiceDto implements IssueInvoiceInput {
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
