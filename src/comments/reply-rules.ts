import { z } from "zod";
import { normalizeForMatching, parseKeywordList } from "./matching";

export interface CommentReplyRule {
  keywords: string[];
  publicReplyText?: string;
  privateReplyText?: string;
  always?: boolean;
}

export type CommentReplyRuleDefinition = readonly [
  keywords: string,
  replies: {
    public?: string;
    private?: string;
    always?: boolean;
  },
];

const commentReplyRuleConfigSchema = z.object({
  keywords: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  public: z.string().optional(),
  private: z.string().optional(),
  publicReplyText: z.string().optional(),
  privateReplyText: z.string().optional(),
  always: z.boolean().optional(),
}).strict().refine(
  (rule) =>
    Boolean(
      cleanReplyText(rule.public) ||
        cleanReplyText(rule.private) ||
        cleanReplyText(rule.publicReplyText) ||
        cleanReplyText(rule.privateReplyText),
    ),
  "rule must define public/private reply text",
);

const commentReplyRulesConfigSchema = z.array(commentReplyRuleConfigSchema).min(1);

type CommentReplyRuleConfig = z.infer<typeof commentReplyRuleConfigSchema>;

export function parseCommentReplyRulesConfig(
  input: unknown,
  sourceName = "reply rules config",
): CommentReplyRule[] {
  try {
    return commentReplyRulesConfigSchema.parse(input).map(normalizeCommentReplyRule);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`${sourceName} is invalid: ${z.prettifyError(error)}`);
    }

    throw error;
  }
}

export function buildCommentReplyRules(
  definitions: readonly CommentReplyRuleDefinition[],
): CommentReplyRule[] {
  return definitions.flatMap(([keywordList, replies]) => {
    const keywords = parseKeywordList(keywordList);
    if (keywords.length === 0) {
      return [];
    }

    return [
      {
        keywords,
        publicReplyText: cleanReplyText(replies.public),
        privateReplyText: cleanReplyText(replies.private),
        always: replies.always === true,
      },
    ];
  });
}

function normalizeCommentReplyRule(rule: CommentReplyRuleConfig): CommentReplyRule {
  const keywordValues = Array.isArray(rule.keywords) ? rule.keywords : [rule.keywords];
  const keywords = keywordValues.flatMap(parseKeywordList);
  if (keywords.length === 0) {
    throw new Error("reply rule must define at least one keyword");
  }

  return {
    keywords,
    publicReplyText: cleanReplyText(rule.publicReplyText) ?? cleanReplyText(rule.public),
    privateReplyText: cleanReplyText(rule.privateReplyText) ?? cleanReplyText(rule.private),
    always: rule.always === true,
  };
}

export function getCommentReplyKeywords(rules: CommentReplyRule[]): string[] {
  return rules.flatMap((rule) => rule.keywords);
}

export function findCommentReplyRule(
  rules: CommentReplyRule[],
  matchedKeyword: string | undefined,
): CommentReplyRule | undefined {
  const normalizedKeyword = normalizeForMatching(matchedKeyword);
  if (!normalizedKeyword) {
    return undefined;
  }

  return rules.find((rule) =>
    rule.keywords.some(
      (keyword) => normalizeForMatching(keyword) === normalizedKeyword,
    ),
  );
}

export function cleanReplyText(value: string | undefined): string | undefined {
  const clean = value?.trim();
  return clean ? clean : undefined;
}
