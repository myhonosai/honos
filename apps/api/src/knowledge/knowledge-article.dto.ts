import {
  KNOWLEDGE_ARTICLE_AUDIENCES,
  type ApproveKnowledgeArticleInput,
  type CreateKnowledgeArticleInput,
  type KnowledgeArticleAudience,
} from '@hon/contracts';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** Draft submission has no client-controlled lifecycle or actor fields. */
export class CreateKnowledgeArticleDto implements CreateKnowledgeArticleInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  body!: string;

  @IsIn([...KNOWLEDGE_ARTICLE_AUDIENCES])
  audience!: KnowledgeArticleAudience;
}

/** Approval identity and timestamp are derived inside the RLS-bound transaction. */
export class ApproveKnowledgeArticleDto implements ApproveKnowledgeArticleInput {
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @IsNotEmpty()
  @IsISO8601({ strict: true })
  effectiveFrom!: string;
}
