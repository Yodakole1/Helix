import type { SampleMessage } from "../data/messages";

export type RuleField = "from" | "subject" | "to";
export type RuleMatch = "contains";

export interface RuleCondition {
  field: RuleField;
  match: RuleMatch;
  value: string;
}

export type RuleAction = { type: "moveTo"; folder: string } | { type: "markRead" } | { type: "star" };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  // All conditions must match (AND) -- a rule with no conditions never
  // matches anything rather than matching everything, so an
  // accidentally-empty rule can't silently sweep every message.
  conditions: RuleCondition[];
  actions: RuleAction[];
}

function fieldValues(message: SampleMessage, field: RuleField): string[] {
  switch (field) {
    case "from":
      return [message.sender, message.senderEmail];
    case "subject":
      return [message.subject];
    case "to":
      return [message.to];
  }
}

function conditionMatches(message: SampleMessage, condition: RuleCondition): boolean {
  const needle = condition.value.trim().toLowerCase();
  if (needle === "") return false;
  return fieldValues(message, condition.field).some((value) => value.toLowerCase().includes(needle));
}

export function matchesRule(message: SampleMessage, rule: Rule): boolean {
  if (!rule.enabled || rule.conditions.length === 0) return false;
  return rule.conditions.every((condition) => conditionMatches(message, condition));
}

// First matching enabled rule wins, same as most real mail clients'
// rule lists -- not every matching rule's actions merged together,
// which would make two rules that both move a message to different
// folders ambiguous.
export function applyRules(rules: Rule[], message: SampleMessage): RuleAction[] {
  const matched = rules.find((rule) => matchesRule(message, rule));
  return matched?.actions ?? [];
}

export function describeCondition(condition: RuleCondition): string {
  const field = condition.field === "from" ? "From" : condition.field === "subject" ? "Subject" : "To";
  return `${field} contains "${condition.value}"`;
}

export function describeAction(action: RuleAction): string {
  switch (action.type) {
    case "moveTo":
      return `Move to ${action.folder}`;
    case "markRead":
      return "Mark as read";
    case "star":
      return "Star";
  }
}
