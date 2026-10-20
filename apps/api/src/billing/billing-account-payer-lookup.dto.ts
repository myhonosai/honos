import { IsString, Length, Matches } from 'class-validator';

export class BillingAccountPayerLookupDto {
  @IsString()
  @Length(2, 20)
  @Matches(/^\S(?:[\s\S]*\S)?$/)
  @Matches(/^[^\u0000-\u001f\u007f-\u009f]*$/u)
  query!: string;
}
