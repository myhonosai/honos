/**
 * A governed knowledge article that is safe for an authorized Parent/Eian
 * family view. Publication, audience, and effective-date checks happen in the
 * server projection; internal lifecycle and approval facts are intentionally
 * not part of this contract.
 */
export interface ParentFamilyKnowledgeArticle {
  id: string;
  title: string;
  body: string;
  effectiveFrom: string;
  version: number;
}

/** A read-only, school-published knowledge feed for one resolver-authorized family. */
export interface ParentFamilyKnowledge {
  articles: ParentFamilyKnowledgeArticle[];
}
