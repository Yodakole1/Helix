import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { FOLDERS } from "../data/folders";
import {
  describeAction,
  describeCondition,
  type Rule,
  type RuleAction,
  type RuleCondition,
  type RuleField,
} from "../lib/rules";
import { colors, fontFamily, fontSize, radii, spacing } from "../theme";
import { Dropdown } from "./Dropdown";
import { ListIcon } from "./ListIcon";
import { settingsStyles } from "./settingsStyles";
import { Switch } from "./Switch";

interface RuleSettingsProps {
  accentColor: string;
  rules: Rule[];
  onSaveRule: (rule: Rule) => void;
  onDeleteRule: (id: string) => void;
}

const FIELD_OPTIONS = [
  { value: "from", label: "From" },
  { value: "subject", label: "Subject" },
  { value: "to", label: "To" },
];

const ACTION_TYPE_OPTIONS = [
  { value: "moveTo", label: "Move to folder" },
  { value: "markRead", label: "Mark as read" },
  { value: "star", label: "Star" },
];

const FOLDER_OPTIONS = FOLDERS.map((folder) => ({ value: folder.id, label: folder.label }));

function blankCondition(): RuleCondition {
  return { field: "from", match: "contains", value: "" };
}

function actionForType(type: string): RuleAction {
  if (type === "moveTo") return { type: "moveTo", folder: FOLDERS[0].id };
  if (type === "markRead") return { type: "markRead" };
  return { type: "star" };
}

// Real and working against the sample message store -- see
// App.tsx's applyRules wiring and docs/technical/ for
// exactly when this runs (folder/account changes, the message list's
// Refresh button) and why it can't run on "new mail arriving" yet.
export function RuleSettings({ accentColor, rules, onSaveRule, onDeleteRule }: RuleSettingsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftConditions, setDraftConditions] = useState<RuleCondition[]>([blankCondition()]);
  const [draftActions, setDraftActions] = useState<RuleAction[]>([actionForType("moveTo")]);

  function startNewRule() {
    setEditingId("new");
    setDraftName("");
    setDraftConditions([blankCondition()]);
    setDraftActions([actionForType("moveTo")]);
  }

  function startEditRule(rule: Rule) {
    setEditingId(rule.id);
    setDraftName(rule.name);
    setDraftConditions(rule.conditions.length > 0 ? rule.conditions : [blankCondition()]);
    setDraftActions(rule.actions.length > 0 ? rule.actions : [actionForType("moveTo")]);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function saveDraft() {
    if (draftName.trim() === "") return;
    const existing = rules.find((rule) => rule.id === editingId);
    onSaveRule({
      id: editingId === "new" ? crypto.randomUUID() : editingId!,
      name: draftName.trim(),
      enabled: existing?.enabled ?? true,
      conditions: draftConditions.filter((condition) => condition.value.trim() !== ""),
      actions: draftActions,
    });
    setEditingId(null);
  }

  function updateCondition(index: number, patch: Partial<RuleCondition>) {
    setDraftConditions((current) => current.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)));
  }

  function removeCondition(index: number) {
    setDraftConditions((current) => current.filter((_, i) => i !== index));
  }

  function updateActionType(index: number, type: string) {
    setDraftActions((current) => current.map((action, i) => (i === index ? actionForType(type) : action)));
  }

  function updateActionFolder(index: number, folder: string) {
    setDraftActions((current) => current.map((action, i) => (i === index && action.type === "moveTo" ? { ...action, folder } : action)));
  }

  function removeAction(index: number) {
    setDraftActions((current) => current.filter((_, i) => i !== index));
  }

  return (
    <View>
      <Text style={settingsStyles.sectionTitle}>Rules & auto-sorting</Text>
      <Text style={settingsStyles.hint}>
        Applied when you open a folder or account, and re-applied by the message list's Refresh button -- there's no
        background mail-checking yet, so nothing runs purely on its own.
      </Text>

      {rules.map((rule) => (
        <View key={rule.id} style={styles.ruleRow}>
          <Switch value={rule.enabled} onChange={() => onSaveRule({ ...rule, enabled: !rule.enabled })} color={accentColor} />
          <View style={styles.ruleText}>
            <Text style={styles.ruleName}>{rule.name}</Text>
            <Text style={styles.ruleSummary} numberOfLines={1}>
              {rule.conditions.map(describeCondition).join(" and ")} {"→"} {rule.actions.map(describeAction).join(", ")}
            </Text>
          </View>
          <Pressable onPress={() => startEditRule(rule)} style={styles.ruleAction}>
            <Text style={[styles.ruleActionText, { color: accentColor }]}>Edit</Text>
          </Pressable>
          <Pressable onPress={() => onDeleteRule(rule.id)} style={styles.ruleAction}>
            <Text style={styles.ruleDeleteText}>Delete</Text>
          </Pressable>
        </View>
      ))}

      {editingId === null ? (
        <Pressable
          onPress={startNewRule}
          style={[settingsStyles.primaryButton, { backgroundColor: accentColor, alignSelf: "flex-start" }]}
        >
          <Text style={settingsStyles.primaryButtonText}>+ New rule</Text>
        </Pressable>
      ) : (
        <View style={styles.editForm}>
          <Text style={settingsStyles.label}>Rule name</Text>
          <TextInput
            style={settingsStyles.input}
            value={draftName}
            onChangeText={setDraftName}
            placeholder="e.g. Archive GitHub notifications"
            placeholderTextColor={colors.text.muted}
          />

          <Text style={settingsStyles.label}>If all of these match...</Text>
          {draftConditions.map((condition, index) => (
            <View key={index} style={styles.row}>
              <Dropdown
                value={condition.field}
                options={FIELD_OPTIONS}
                onChange={(value) => updateCondition(index, { field: value as RuleField })}
                accentColor={accentColor}
                width={90}
              />
              <Text style={styles.containsLabel}>contains</Text>
              <TextInput
                style={[settingsStyles.input, styles.conditionValueInput]}
                value={condition.value}
                onChangeText={(value) => updateCondition(index, { value })}
                placeholder="value"
                placeholderTextColor={colors.text.muted}
              />
              {draftConditions.length > 1 && (
                <Pressable onPress={() => removeCondition(index)} style={styles.removeRow}>
                  <ListIcon name="close" color={colors.text.muted} size={12} />
                </Pressable>
              )}
            </View>
          ))}
          <Pressable onPress={() => setDraftConditions((current) => [...current, blankCondition()])}>
            <Text style={[styles.addLink, { color: accentColor }]}>+ Add condition</Text>
          </Pressable>

          <Text style={settingsStyles.label}>Then...</Text>
          {draftActions.map((action, index) => (
            <View key={index} style={styles.row}>
              <Dropdown
                value={action.type}
                options={ACTION_TYPE_OPTIONS}
                onChange={(value) => updateActionType(index, value)}
                accentColor={accentColor}
                width={140}
              />
              {action.type === "moveTo" && (
                <Dropdown
                  value={action.folder}
                  options={FOLDER_OPTIONS}
                  onChange={(value) => updateActionFolder(index, value)}
                  accentColor={accentColor}
                  width={110}
                />
              )}
              {draftActions.length > 1 && (
                <Pressable onPress={() => removeAction(index)} style={styles.removeRow}>
                  <ListIcon name="close" color={colors.text.muted} size={12} />
                </Pressable>
              )}
            </View>
          ))}
          <Pressable onPress={() => setDraftActions((current) => [...current, actionForType("markRead")])}>
            <Text style={[styles.addLink, { color: accentColor }]}>+ Add action</Text>
          </Pressable>

          <View style={[settingsStyles.row, styles.formButtons]}>
            <Pressable onPress={cancelEdit} style={settingsStyles.secondaryButton}>
              <Text style={settingsStyles.secondaryButtonText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={saveDraft} style={[settingsStyles.primaryButton, { backgroundColor: accentColor }]}>
              <Text style={settingsStyles.primaryButtonText}>Save rule</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  ruleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.background.surface,
    marginBottom: spacing.xs,
  },
  ruleText: {
    flex: 1,
    marginLeft: spacing.sm,
    marginRight: spacing.md,
  },
  ruleName: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.sm,
    fontWeight: "600",
    color: colors.text.primary,
  },
  ruleSummary: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    color: colors.text.muted,
  },
  ruleAction: {
    marginLeft: spacing.md,
  },
  ruleActionText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
  },
  ruleDeleteText: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    color: colors.accent.amber,
  },
  editForm: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    backgroundColor: colors.background.surface,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  containsLabel: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    color: colors.text.muted,
    marginHorizontal: spacing.sm,
  },
  conditionValueInput: {
    flex: 1,
    marginBottom: 0,
  },
  removeRow: {
    marginLeft: spacing.sm,
  },
  addLink: {
    fontFamily: fontFamily.ui,
    fontSize: fontSize.xs,
    fontWeight: "600",
    marginBottom: spacing.md,
  },
  formButtons: {
    marginTop: spacing.md,
    marginBottom: 0,
  },
});
