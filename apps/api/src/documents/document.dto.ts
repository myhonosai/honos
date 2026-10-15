import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
export class CreateDocumentTemplateDto {
  @IsString() @Length(1,200) title!: string;
  @IsString() @Length(1,100000) content!: string;
  @IsIn(['STAFF','PARENT']) audience!: 'STAFF' | 'PARENT';
  @IsOptional() @IsUUID() familyId?: string;
}
export class CreateDocumentVersionDto {
  @IsInt() @Min(1) @Max(999999999) expectedVersion!: number;
  @IsString() @Length(1,200) title!: string;
  @IsString() @Length(1,100000) content!: string;
}
export class PublishDocumentDto {
  @IsInt() @Min(1) @Max(999999999) expectedVersion!: number;
  @IsUUID() versionId!: string;
}
export class AcknowledgeDocumentDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) contentHash!: string;
  @IsIn(['ACKNOWLEDGE']) choice!: 'ACKNOWLEDGE';
  @IsOptional() @IsString() @Length(1,500) attestationText?: string;
}
