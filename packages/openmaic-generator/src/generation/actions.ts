import { ACTION_TYPES, SLIDE_ONLY_ACTIONS, type Action, type ActionType } from '@openmaic/dsl';
import { jsonrepair } from 'jsonrepair';
import { nanoid } from 'nanoid';

export function parseActions(
  response: string,
  sceneType: string,
  allowed?: readonly ActionType[],
): Action[] {
  const clean = response
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '');
  const start = clean.indexOf('[');
  const end = clean.lastIndexOf(']');
  if (start < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(end > start ? clean.slice(start, end + 1) : clean.slice(start));
  } catch {
    try {
      parsed = JSON.parse(
        jsonrepair(end > start ? clean.slice(start, end + 1) : clean.slice(start)),
      );
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const actions: Action[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (value.type === 'text' && typeof value.content === 'string' && value.content.trim()) {
      actions.push({ id: `action_${nanoid(8)}`, type: 'speech', text: value.content.trim() });
      continue;
    }
    if (value.type !== 'action') continue;
    const name = value.name ?? value.tool_name;
    if (typeof name !== 'string' || !(ACTION_TYPES as readonly string[]).includes(name)) continue;
    const params = (value.params ?? value.parameters ?? {}) as Record<string, unknown>;
    const action = {
      id: typeof value.action_id === 'string' ? value.action_id : `action_${nanoid(8)}`,
      type: name,
      ...params,
    } as Action;
    if (action.type === 'widget_setState' && action.state == null) action.state = {};
    actions.push(action);
  }
  const discussionIndex = actions.findIndex((action) => action.type === 'discussion');
  const bounded = discussionIndex >= 0 ? actions.slice(0, discussionIndex + 1) : actions;
  return bounded.filter((action) => {
    if (sceneType !== 'slide' && SLIDE_ONLY_ACTIONS.includes(action.type)) return false;
    return action.type === 'speech' || !allowed || allowed.includes(action.type);
  });
}
