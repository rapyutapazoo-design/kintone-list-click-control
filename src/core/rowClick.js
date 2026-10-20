/**
 * 行クリック判定（純粋関数）。
 */

export const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [contenteditable=""], [contenteditable="true"]';

/**
 * @param {{
 *  targetView: boolean, rowClick: 'default'|'row', button: number,
 *  hasSelectionInRow: boolean, insideInteractive: boolean, isDataCell: boolean,
 *  rowHasFormControl: boolean, recordId: string|null
 * }} ctx
 * @returns {{action: 'none'|'navigate', reason: string}}
 */
export function decideRowClick(ctx) {
  if (!ctx.targetView || ctx.rowClick !== 'row') return { action: 'none', reason: 'disabled' };
  if (ctx.button === 2) return { action: 'none', reason: 'right-click' };
  if (ctx.hasSelectionInRow) return { action: 'none', reason: 'selection' };
  if (ctx.insideInteractive) return { action: 'none', reason: 'interactive' };
  if (!ctx.isDataCell) return { action: 'none', reason: 'non-data-cell' };
  if (ctx.rowHasFormControl) return { action: 'none', reason: 'inline-edit' };
  if (!ctx.recordId) return { action: 'none', reason: 'no-record' };
  return { action: 'navigate', reason: 'ok' };
}

/**
 * @param {{openMode: 'same'|'new', ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, button?: number, targetBlank?: boolean}} p
 * @returns {'same'|'new'}
 */
export function resolveOpenMode({ openMode, ctrlKey, metaKey, shiftKey, button, targetBlank }) {
  if (targetBlank || ctrlKey || metaKey || shiftKey || button === 1) return 'new';
  return openMode === 'new' ? 'new' : 'same';
}

/**
 * リンクのクリック時に遷移先を決める（純粋関数）。
 * @param {{state: 'allow'|'deny'|'notfound'|'error'|'timeout', onDeny: 'self'|'disable', onError: 'standard'|'self'|'disable'}} p
 * @returns {{action: 'target'|'self'|'block', reason: 'allow'|'deny'|'notfound'|'error'|'timeout'}}
 */
export function decideLinkClick({ state, onDeny, onError }) {
  if (state === 'allow') return { action: 'target', reason: 'allow' };
  if (state === 'deny' || state === 'notfound') {
    return { action: onDeny === 'disable' ? 'block' : 'self', reason: state };
  }
  const reason = state === 'timeout' ? 'timeout' : 'error';
  if (onError === 'standard') return { action: 'target', reason };
  if (onError === 'disable') return { action: 'block', reason };
  return { action: 'self', reason };
}
