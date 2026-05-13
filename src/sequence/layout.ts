import type { SequenceDiagram, PositionedSequenceDiagram, PositionedActor, Lifeline, PositionedMessage, Activation, PositionedBlock, PositionedNote } from './types.ts'
import type { RenderOptions } from '../types.ts'
import { estimateTextWidth, FONT_SIZES, FONT_WEIGHTS } from '../styles.ts'

// ============================================================================
// Sequence diagram layout engine
//
// Custom timeline-based layout (no ELK — sequence diagrams aren't graphs).
//
// Layout strategy:
//   1. Space actors horizontally based on label widths + min gap
//   2. Stack messages vertically in chronological order
//   3. Track activation boxes via a stack
//   4. Position blocks (loop/alt/opt) as background rectangles
//   5. Position notes next to their target actors
// ============================================================================

/** Layout constants specific to sequence diagrams */
const SEQ = {
  /** Padding around the entire diagram */
  padding: 30,
  /** Minimum gap between actor centers */
  actorGap: 140,
  /** Actor box height */
  actorHeight: 40,
  /** Horizontal padding inside actor boxes */
  actorPadX: 16,
  /** Vertical space between actor boxes and first message */
  headerGap: 20,
  /** Vertical space per message row */
  messageRowHeight: 40,
  /** Extra vertical space for self-messages (they loop back) */
  selfMessageHeight: 30,
  /** Activation box width (narrow rectangle on lifeline) */
  activationWidth: 10,
  /** Block padding (loop/alt borders) */
  blockPadX: 10,
  blockPadTop: 40,
  blockPadBottom: 8,
  /** Extra vertical space before the first message in a block (room for the header label) */
  blockHeaderExtra: 28,
  /** Extra vertical space before a message at a divider boundary (room for else/and label) */
  dividerExtra: 24,
  /** Note dimensions */
  noteWidth: 60,
  notePadX: 12,
  notePadY: 6,
  noteGap: 10,
} as const

/**
 * Lay out a parsed sequence diagram.
 * Returns a fully positioned diagram ready for SVG rendering.
 */
export function layoutSequenceDiagram(
  diagram: SequenceDiagram,
  _options: RenderOptions = {}
): PositionedSequenceDiagram {
  if (diagram.actors.length === 0) {
    return { width: 0, height: 0, actors: [], lifelines: [], messages: [], activations: [], blocks: [], notes: [] }
  }

  // 1. Calculate actor widths and assign horizontal positions (center X)
  const actorWidths = diagram.actors.map(a => {
    const textW = estimateTextWidth(a.label, FONT_SIZES.nodeLabel, FONT_WEIGHTS.nodeLabel)
    return Math.max(textW + SEQ.actorPadX * 2, 80)
  })

  // Build actor center X positions with minimum gap
  const actorCenterX: number[] = []
  let currentX = SEQ.padding + actorWidths[0]! / 2
  for (let i = 0; i < diagram.actors.length; i++) {
    if (i > 0) {
      const minGap = Math.max(SEQ.actorGap, (actorWidths[i - 1]! + actorWidths[i]!) / 2 + 40)
      currentX += minGap
    }
    actorCenterX.push(currentX)
  }

  // Build actor ID → index lookup
  const actorIndex = new Map<string, number>()
  for (let i = 0; i < diagram.actors.length; i++) {
    actorIndex.set(diagram.actors[i]!.id, i)
  }

  // 2. Position actors at the top
  const actorY = SEQ.padding
  const actors: PositionedActor[] = diagram.actors.map((a, i) => ({
    id: a.id,
    label: a.label,
    type: a.type,
    x: actorCenterX[i]!,
    y: actorY,
    width: actorWidths[i]!,
    height: SEQ.actorHeight,
  }))

  // 3. Stack messages vertically
  let messageY = actorY + SEQ.actorHeight + SEQ.headerGap
  const messages: PositionedMessage[] = []

  // Helpers for note sizing and X positioning. Hoisted so the same logic is
  // reused for both "after" notes (positioned below a message) and "before"
  // notes (positioned above a message at the start of a block or diagram).
  const noteH = FONT_SIZES.edgeLabel + SEQ.notePadY * 2

  /**
   * Compute a note's width. For `Note over A,B,...` with at least two actors
   * we stretch the note to span from the leftmost referenced actor's left
   * edge to the rightmost referenced actor's right edge, matching Mermaid.js.
   * The text width is used as a lower bound so long captions still fit.
   */
  const computeNoteWidth = (note: { text: string; position: 'left' | 'right' | 'over'; actorIds: string[] }): number => {
    const textW = estimateTextWidth(note.text, FONT_SIZES.edgeLabel, FONT_WEIGHTS.edgeLabel) + SEQ.notePadX * 2
    if (note.position === 'over' && note.actorIds.length >= 2) {
      const firstIdx = actorIndex.get(note.actorIds[0] ?? '') ?? 0
      const lastIdx = actorIndex.get(note.actorIds[note.actorIds.length - 1] ?? '') ?? firstIdx
      const minIdx = Math.min(firstIdx, lastIdx)
      const maxIdx = Math.max(firstIdx, lastIdx)
      const rangeW = (actorCenterX[maxIdx]! + actorWidths[maxIdx]! / 2) - (actorCenterX[minIdx]! - actorWidths[minIdx]! / 2)
      return Math.max(rangeW, textW)
    }
    return Math.max(SEQ.noteWidth, textW)
  }

  /** Compute a note's X position given its already-computed width. */
  const computeNoteX = (note: { position: 'left' | 'right' | 'over'; actorIds: string[] }, width: number): number => {
    const firstActorIdx = actorIndex.get(note.actorIds[0] ?? '') ?? 0
    if (note.position === 'left') {
      return actorCenterX[firstActorIdx]! - actorWidths[firstActorIdx]! / 2 - width - SEQ.noteGap
    }
    if (note.position === 'right') {
      return actorCenterX[firstActorIdx]! + actorWidths[firstActorIdx]! / 2 + SEQ.noteGap
    }
    // `over`
    if (note.actorIds.length > 1) {
      const lastActorIdx = actorIndex.get(note.actorIds[note.actorIds.length - 1] ?? '') ?? firstActorIdx
      const minIdx = Math.min(firstActorIdx, lastActorIdx)
      const maxIdx = Math.max(firstActorIdx, lastActorIdx)
      const rangeLeft = actorCenterX[minIdx]! - actorWidths[minIdx]! / 2
      const rangeRight = actorCenterX[maxIdx]! + actorWidths[maxIdx]! / 2
      return (rangeLeft + rangeRight) / 2 - width / 2
    }
    return actorCenterX[firstActorIdx]! - width / 2
  }

  // Pre-scan blocks to determine which message indices need extra vertical
  // space for block headers (e.g. "alt [Valid credentials]") or divider
  // labels (e.g. "[else Invalid]"). Without this, messages inside blocks
  // overlap with the header/divider text that sits above them.
  const extraSpaceBefore = new Map<number, number>()
  for (const block of diagram.blocks) {
    // First message in the block needs room for the block header label
    const prev = extraSpaceBefore.get(block.startIndex) ?? 0
    extraSpaceBefore.set(block.startIndex, Math.max(prev, SEQ.blockHeaderExtra))

    // Each divider (else/and) needs room for the divider label
    for (const div of block.dividers) {
      const prevDiv = extraSpaceBefore.get(div.index) ?? 0
      extraSpaceBefore.set(div.index, Math.max(prevDiv, SEQ.dividerExtra))
    }
  }

  // Pre-group notes by their semantic anchor:
  //   - `notesByAfterIndex` holds notes that appear BELOW the message at
  //     their `afterIndex` (the default, e.g. `A->>B: ... ; Note over A,B: ...`).
  //   - `notesByBeforeIndex` holds notes whose `before` flag is true. These
  //     were parsed at the start of a block (or before any message), and must
  //     render ABOVE the message at `afterIndex + 1` so they land *inside*
  //     the surrounding block rather than in the gap before it.
  const notesByAfterIndex = new Map<number, typeof diagram.notes>()
  const notesByBeforeIndex = new Map<number, typeof diagram.notes>()
  for (const note of diagram.notes) {
    if (note.before) {
      const target = note.afterIndex + 1
      const list = notesByBeforeIndex.get(target) ?? []
      list.push(note)
      notesByBeforeIndex.set(target, list)
    } else {
      const list = notesByAfterIndex.get(note.afterIndex) ?? []
      list.push(note)
      notesByAfterIndex.set(note.afterIndex, list)
    }
  }

  // Reserve vertical space above each target message to fit its before-notes,
  // and track how much top padding each block needs to grow by so its header
  // tab clears the notes (otherwise the tab would overlap a note that's the
  // first content inside the block).
  //
  // Per before-note: noteH + 4 (gap above the note). Plus a trailing
  // `noteToMessageGap` between the last note's bottom and the message arrow,
  // sized to clear the message label (rendered at msg.y - 10 with font
  // FONT_SIZES.edgeLabel, so its visual top sits ~20px above the arrow).
  const noteToMessageGap = 24
  const beforeNotesExtraByMsgIdx = new Map<number, number>()
  for (const [target, notes] of notesByBeforeIndex) {
    const totalH = notes.length * (noteH + 4) + noteToMessageGap
    beforeNotesExtraByMsgIdx.set(target, totalH)
    const prev = extraSpaceBefore.get(target) ?? 0
    extraSpaceBefore.set(target, prev + totalH)
  }
  // Map blockIndex → extra top padding for blocks that contain a before-note
  // as their first content.
  const blockExtraTop = new Map<number, number>()
  diagram.blocks.forEach((block, bi) => {
    const extra = beforeNotesExtraByMsgIdx.get(block.startIndex) ?? 0
    if (extra > 0) blockExtraTop.set(bi, extra)
  })

  const positionedNotes: PositionedNote[] = []

  /** Place "before" notes in the reserved space immediately above msgY. */
  const placeBeforeNotes = (msgIdx: number, msgY: number) => {
    const notes = notesByBeforeIndex.get(msgIdx)
    if (!notes || notes.length === 0) return
    // Stack notes upward from (msgY - noteToMessageGap) so the last note's
    // bottom clears the message label, then each preceding note sits above
    // with a 4px gap. The reserved space (see `beforeNotesExtraByMsgIdx`
    // above) sums to exactly `notes.length * (noteH + 4) + noteToMessageGap`,
    // matching this layout.
    let cursor = msgY - noteToMessageGap
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i]!
      const w = computeNoteWidth(note)
      cursor -= noteH
      positionedNotes.push({
        text: note.text,
        x: computeNoteX(note, w),
        y: cursor,
        width: w,
        height: noteH,
        position: note.position,
        actors: note.actorIds,
      })
      cursor -= 4
    }
  }

  // Track activation stack per actor: array of { startY, depth } objects
  // Depth is used to offset nested activations horizontally for visual clarity
  const activationStacks = new Map<string, { startY: number; depth: number }[]>()
  const activations: Activation[] = []
  const nestingOffset = 4 // Horizontal offset per nesting level

  for (let msgIdx = 0; msgIdx < diagram.messages.length; msgIdx++) {
    const msg = diagram.messages[msgIdx]!
    const fromIdx = actorIndex.get(msg.from) ?? 0
    const toIdx = actorIndex.get(msg.to) ?? 0
    const isSelf = msg.from === msg.to

    // Add extra vertical space if this message sits below a block header,
    // divider, or any before-notes anchored to this message.
    const extra = extraSpaceBefore.get(msgIdx) ?? 0
    if (extra > 0) messageY += extra

    // Position before-notes (notes that appeared at the start of a block or
    // before any message) in the reserved space immediately above this
    // message. blockExtraTop above guarantees the block's tab header is
    // already drawn higher than where these notes will land.
    placeBeforeNotes(msgIdx, messageY)

    const x1 = actorCenterX[fromIdx]!
    const x2 = actorCenterX[toIdx]!

    messages.push({
      from: msg.from,
      to: msg.to,
      label: msg.label,
      lineStyle: msg.lineStyle,
      arrowHead: msg.arrowHead,
      x1, x2,
      y: messageY,
      isSelf,
    })

    // Handle activation - track nesting depth for visual offset
    if (msg.activate) {
      if (!activationStacks.has(msg.to)) {
        activationStacks.set(msg.to, [])
      }
      const stack = activationStacks.get(msg.to)!
      const depth = stack.length // Current depth before pushing
      stack.push({ startY: messageY, depth })
    }

    if (msg.deactivate) {
      const stack = activationStacks.get(msg.from)
      if (stack && stack.length > 0) {
        const { startY, depth } = stack.pop()!
        const idx = actorIndex.get(msg.from) ?? 0
        // Offset nested activations to the right for visual distinction
        const xOffset = depth * nestingOffset
        activations.push({
          actorId: msg.from,
          x: actorCenterX[idx]! - SEQ.activationWidth / 2 + xOffset,
          topY: startY,
          bottomY: messageY,
          width: SEQ.activationWidth,
        })
      }
    }

    // Advance messageY past the message itself
    messageY += isSelf ? SEQ.selfMessageHeight + SEQ.messageRowHeight : SEQ.messageRowHeight

    // Position notes that appear after this message.
    // Notes start below the self-message loop (if self) or below the arrow,
    // and consecutive notes stack vertically. If notes extend beyond the
    // normal message advance, push messageY further so subsequent messages
    // don't overlap.
    const notesForMsg = notesByAfterIndex.get(msgIdx)
    if (notesForMsg && notesForMsg.length > 0) {
      // Self-message loops extend selfMessageHeight below msg.y;
      // normal arrows sit at msg.y with no extension below.
      const selfLoopExtra = isSelf ? SEQ.selfMessageHeight : 0
      let noteY = messages[msgIdx]!.y + selfLoopExtra + 8

      for (const note of notesForMsg) {
        const noteW = computeNoteWidth(note)
        const noteX = computeNoteX(note, noteW)

        positionedNotes.push({
          text: note.text,
          x: noteX,
          y: noteY,
          width: noteW,
          height: noteH,
          position: note.position,
          actors: note.actorIds,
        })

        noteY += noteH + 4 // Stack next note below with gap
      }

      // Push messageY forward if notes extended beyond the normal advance.
      // Add half a row height so the next message's label (rendered at msg.y - 6)
      // has clearance from the last note's bottom edge.
      messageY = Math.max(messageY, noteY + SEQ.messageRowHeight / 2)
    }
  }

  // Close any unclosed activations (preserving depth for offset)
  for (const [actorId, stack] of activationStacks) {
    for (const { startY, depth } of stack) {
      const idx = actorIndex.get(actorId) ?? 0
      const xOffset = depth * nestingOffset
      activations.push({
        actorId,
        x: actorCenterX[idx]! - SEQ.activationWidth / 2 + xOffset,
        topY: startY,
        bottomY: messageY - SEQ.messageRowHeight / 2,
        width: SEQ.activationWidth,
      })
    }
  }

  // 4. Position blocks (loop/alt/opt)
  const blocks: PositionedBlock[] = diagram.blocks.map((block, bi) => {
    // Block spans from the Y of startIndex to endIndex messages. When the
    // block opens with before-notes as its first content, extend the top
    // padding by their total vertical contribution so the block's header
    // tab is drawn above the notes (otherwise the tab and the topmost note
    // would overlap).
    const startMsg = messages[block.startIndex]
    const endMsg = messages[block.endIndex]
    const extraTop = blockExtraTop.get(bi) ?? 0
    const blockTop = (startMsg?.y ?? messageY) - SEQ.blockPadTop - extraTop
    const blockBottom = (endMsg?.y ?? messageY) + SEQ.blockPadBottom + 12

    // Block width spans all actors involved in its messages
    const involvedActors = new Set<number>()
    for (let mi = block.startIndex; mi <= block.endIndex; mi++) {
      const m = diagram.messages[mi]
      if (m) {
        involvedActors.add(actorIndex.get(m.from) ?? 0)
        involvedActors.add(actorIndex.get(m.to) ?? 0)
      }
    }
    // Fallback: span all actors if none involved
    if (involvedActors.size === 0) {
      for (let ai = 0; ai < diagram.actors.length; ai++) involvedActors.add(ai)
    }
    const minIdx = Math.min(...involvedActors)
    const maxIdx = Math.max(...involvedActors)
    const blockLeft = actorCenterX[minIdx]! - actorWidths[minIdx]! / 2 - SEQ.blockPadX
    const blockRight = actorCenterX[maxIdx]! + actorWidths[maxIdx]! / 2 + SEQ.blockPadX

    // Position dividers — offset from message Y so the divider label text
    // (rendered at divider.y + 14 in the renderer) clears the message label
    // (rendered at msg.y - 6).
    //
    // Default offset 28 gives ~8px baseline clearance, which is sufficient
    // when the divider label (left-aligned at block edge) and message label
    // (centered between actors) don't share horizontal space. When they DO
    // overlap horizontally (e.g. long divider labels like "[Account locked]"
    // next to centered message labels like "403 Forbidden"), we increase the
    // offset to 36 so text bounding boxes have ~5px visual clearance.
    const dividers = block.dividers.map(d => {
      const msg = messages[d.index]
      const msgY = msg?.y ?? messageY
      let offset = 28

      // Dynamic overlap detection: increase offset when the divider label
      // and message label occupy the same horizontal region, which would
      // cause vertical text overlap at the default 8px baseline gap.
      if (d.label && msg?.label) {
        const divLabelText = `[${d.label}]`
        const divLabelW = estimateTextWidth(divLabelText, FONT_SIZES.edgeLabel, FONT_WEIGHTS.edgeLabel)
        const divLabelLeft = blockLeft + 8
        const divLabelRight = divLabelLeft + divLabelW

        const msgLabelW = estimateTextWidth(msg.label, FONT_SIZES.edgeLabel, FONT_WEIGHTS.edgeLabel)
        // Self-messages render labels at x1 + 36 (left-aligned); normal
        // messages center the label between the two actor lifelines.
        const msgLabelLeft = msg.isSelf
          ? msg.x1 + 36
          : (msg.x1 + msg.x2) / 2 - msgLabelW / 2
        const msgLabelRight = msgLabelLeft + msgLabelW

        if (divLabelRight > msgLabelLeft && divLabelLeft < msgLabelRight) {
          offset = 36
        }
      }

      return { y: msgY - offset, label: d.label }
    })

    return {
      type: block.type,
      label: block.label,
      x: blockLeft,
      y: blockTop,
      width: blockRight - blockLeft,
      height: blockBottom - blockTop,
      dividers,
    }
  })

  // 5. Notes — already positioned inline during the message stacking loop
  //    (step 3) to properly account for self-message loops and vertical stacking.
  const notes = positionedNotes

  // 6. Bounding-box post-processing
  //
  // Notes positioned "left of" the first actor or "right of" the last actor
  // can extend beyond the actor-based viewport. Compute the true bounding box
  // across all positioned elements, then shift everything right if anything
  // extends left of the desired padding margin and expand the width to fit.
  const diagramBottom = messageY + SEQ.padding

  // Find global X extents across actors, blocks, notes, and message labels
  let globalMinX: number = SEQ.padding // actors already start at SEQ.padding
  let globalMaxX = 0
  for (const a of actors) {
    globalMinX = Math.min(globalMinX, a.x - a.width / 2)
    globalMaxX = Math.max(globalMaxX, a.x + a.width / 2)
  }
  for (const b of blocks) {
    globalMinX = Math.min(globalMinX, b.x)
    globalMaxX = Math.max(globalMaxX, b.x + b.width)
  }
  for (const n of notes) {
    globalMinX = Math.min(globalMinX, n.x)
    globalMaxX = Math.max(globalMaxX, n.x + n.width)
  }
  // Include self-message labels in bounding box — they extend to the right of the actor
  // and could be clipped if not accounted for in the SVG width
  for (const m of messages) {
    if (m.isSelf && m.label) {
      const loopW = 30 // matches renderer loopW
      const labelPadding = 8
      const labelLeft = m.x1 + loopW + labelPadding
      const labelWidth = estimateTextWidth(m.label, FONT_SIZES.edgeLabel, FONT_WEIGHTS.edgeLabel)
      globalMaxX = Math.max(globalMaxX, labelLeft + labelWidth + 8) // +8 for safety margin
    }
  }

  // If elements extend left of the desired padding, shift everything right
  const shiftX = globalMinX < SEQ.padding ? SEQ.padding - globalMinX : 0
  if (shiftX > 0) {
    for (const a of actors) a.x += shiftX
    for (const m of messages) { m.x1 += shiftX; m.x2 += shiftX }
    for (const act of activations) act.x += shiftX
    for (const b of blocks) { b.x += shiftX; }
    for (const n of notes) n.x += shiftX
    // Also shift actor center X array (used for lifelines below)
    for (let i = 0; i < actorCenterX.length; i++) actorCenterX[i]! += shiftX
  }

  // 7. Calculate final lifelines (after shift so X positions are correct)
  const lifelines: Lifeline[] = diagram.actors.map((a, i) => ({
    actorId: a.id,
    x: actorCenterX[i]!,
    topY: actorY + SEQ.actorHeight,
    bottomY: diagramBottom - SEQ.padding,
  }))

  // 8. Calculate diagram dimensions from the bounding box
  const diagramWidth = globalMaxX + shiftX + SEQ.padding
  const diagramHeight = diagramBottom

  return {
    width: Math.max(diagramWidth, 200),
    height: Math.max(diagramHeight, 100),
    actors,
    lifelines,
    messages,
    activations,
    blocks,
    notes,
  }
}
