import {
  ISO_4217_CURRENCIES,
  type CreateInvoiceDraftInput,
  type Iso4217Currency,
} from '@hon/contracts';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const TIMEZONE_QUALIFIED_ISO_8601 = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The invoice schema has no line-item or free-text relation. This deliberately
 * narrow DTO maps only to its existing account, optional membership, money,
 * currency, and due-date columns. Total and discount are server-derived.
 */
export class CreateInvoiceDraftDto implements CreateInvoiceDraftInput {
  @IsUUID()
  billingAccountId!: string;

  @IsOptional()
  @IsUUID()
  membershipId?: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(TIMEZONE_QUALIFIED_ISO_8601, {
    message: 'dueAt must include a UTC Z or numeric timezone offset.',
  })
  @MaxLength(40)
  dueAt!: string;

  @IsIn([...ISO_4217_CURRENCIES])
  currency!: Iso4217Currency;

  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  subtotalMinor!: number;
}
