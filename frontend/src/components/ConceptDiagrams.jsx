/**
 * ConceptDiagrams
 * ---------------
 * SVG renderers for every structure-based concept the project teaches:
 * tree, linked list, stack, queue, graph, hash table — plus a `<pre>`
 * fallback for free-form ASCII diagrams (legacy cached explanations
 * still have these).
 *
 * Why SVG instead of ASCII art?
 *   1. Parent–child relationships are *geometrically* obvious; we
 *      compute coordinates from the tree shape so a missing right
 *      child literally cannot be omitted by the LLM.
 *   2. No proportional-font alignment problems: lines connect node
 *      centres, no whitespace counting required.
 *   3. Beginner students glance at it and immediately see the shape.
 *
 * Data shape produced by the Groq prompt (keys are tolerant of common
 * LLM variations — see DiagramView for the dispatch table):
 *
 *   { kind: "tree",       root: {value, label?, left?, right?} }
 *   { kind: "list",       items: ["3", "7", "12"], terminator?: "NULL" }
 *   { kind: "stack",      items: [...top first...] }
 *   { kind: "queue",      items: [...front first...] }
 *   { kind: "graph",      nodes: [{id,label?}], edges: [{from,to,weight?}], directed?: bool }
 *   { kind: "hashTable",  buckets: [{index, items: ["Alice","Bob"]}] }
 *   { kind: "ascii",      text: "raw ASCII art" }
 *
 * Every diagram object can also carry an optional `rule` (one-line
 * teaching rule rendered under the SVG) and `caption` (rendered over
 * it). The renderer never hallucinates either field.
 */

// ── public entry point ────────────────────────────────────────────────────

/**
 * Render any of the supported diagram shapes. Tolerant of:
 *   - string input (legacy ASCII explanation cached before this rewrite)
 *   - missing `kind` (treated as ascii fallback)
 *   - alternative key names (linkedList vs list, kind vs type)
 *   - empty / partial structures (renders what it can without crashing)
 *
 * Props
 * -----
 *   diagram   : object | string — the LLM payload or legacy text.
 *   label     : optional small uppercase label above the diagram
 *               ("Concept Structure" / "Real Example").
 *   accent    : hex / rgb stroke colour for nodes + lines.
 */
export function DiagramView({ diagram, label, accent = "#a78bfa" }) {
  if (diagram == null) return null;

  // Legacy: caller passed raw ASCII string. Render as <pre> so old
  // saved explanations from before the structured-diagram migration
  // still display correctly.
  if (typeof diagram === "string") {
    return (
      <DiagramShell label={label} accent={accent}>
        <AsciiDiagram text={diagram} />
      </DiagramShell>
    );
  }

  if (typeof diagram !== "object") return null;

  // The LLM occasionally uses `type` instead of `kind`. Be permissive.
  const rawKind = (diagram.kind || diagram.type || "ascii").toString().toLowerCase();
  const kind = normaliseKind(rawKind);

  let body = null;
  switch (kind) {
    case "tree":
      body = diagram.root ? <TreeDiagram root={diagram.root} accent={accent} /> : null;
      break;
    case "list":
      body = (
        <ListDiagram
          items={readItems(diagram)}
          terminator={diagram.terminator || diagram.endsWith || "NULL"}
          accent={accent}
        />
      );
      break;
    case "stack":
      body = <StackDiagram items={readItems(diagram)} accent={accent} />;
      break;
    case "queue":
      body = <QueueDiagram items={readItems(diagram)} accent={accent} />;
      break;
    case "graph":
      body = (
        <GraphDiagram
          nodes={diagram.nodes || []}
          edges={diagram.edges || []}
          directed={Boolean(diagram.directed)}
          accent={accent}
        />
      );
      break;
    case "hashtable":
      body = (
        <HashTableDiagram
          buckets={readBuckets(diagram)}
          accent={accent}
        />
      );
      break;
    case "ascii":
    default:
      body = (
        <AsciiDiagram
          text={
            diagram.text ||
            diagram.ascii ||
            // last-resort: stringify the whole thing so the user can
            // at least see the data, instead of a blank pane.
            JSON.stringify(diagram, null, 2)
          }
        />
      );
      break;
  }

  // If the structured renderer produced nothing (e.g. empty tree), fall
  // back to ASCII so the pane is never blank.
  if (!body) {
    body = (
      <AsciiDiagram
        text={diagram.text || JSON.stringify(diagram, null, 2)}
      />
    );
  }

  return (
    <DiagramShell
      label={label}
      caption={diagram.caption}
      rule={diagram.rule}
      accent={accent}
    >
      {body}
    </DiagramShell>
  );
}

// ── shell (label + bordered container + caption + rule) ──────────────────

function DiagramShell({ label, caption, rule, accent, children }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
        flex: 1,
      }}
    >
      {label ? (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: accent,
          }}
        >
          {label}
        </span>
      ) : null}
      {caption ? (
        <p
          style={{
            margin: 0,
            fontSize: 11,
            color: "#94a3b8",
            lineHeight: 1.4,
          }}
        >
          {caption}
        </p>
      ) : null}
      <div
        style={{
          background: "#0b1220",
          border: `1px solid ${hexAlpha(accent, 0.25)}`,
          borderRadius: 8,
          padding: "12px 14px",
          overflowX: "auto",
          // Gives the SVG breathing room and keeps long ASCII art
          // scrollable instead of squished.
          minHeight: 120,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {children}
      </div>
      {rule ? (
        <p
          style={{
            margin: "2px 0 0",
            fontSize: 11,
            color: "#cbd5e1",
            paddingLeft: 4,
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
          }}
        >
          <span style={{ color: accent, fontWeight: 700 }}>↳</span>
          <span style={{ fontStyle: "italic" }}>{rule}</span>
        </p>
      ) : null}
    </div>
  );
}

// ── tree ──────────────────────────────────────────────────────────────────
//
// Layout: classic in-order traversal. Each node gets an integer x-column
// equal to the count of nodes already visited at *any* ancestor on its
// left. y is the depth. This guarantees:
//   - No two nodes share an (x, y) cell.
//   - The visual order matches the in-order order, which for a BST is
//     the sorted order — students see "Left < Parent < Right" laid out
//     left-to-right, matching how it's usually written on a board.
//   - Lines never cross because subtrees occupy disjoint x-ranges.

function TreeDiagram({ root, accent }) {
  const layout = layoutTree(root);
  if (!layout) return null;

  const nodes = collectNodes(layout);
  if (nodes.length === 0) return null;

  // Width of the widest label decides column spacing for the *whole*
  // tree, otherwise ovals would overlap when one node is "Left Child"
  // and another is just "30".
  const maxWidth = Math.max(
    ...nodes.map((n) =>
      Math.max(estimateTextWidth(n.value), estimateTextWidth(n.label || ""))
    )
  );
  const NODE_W = clamp(maxWidth + 20, 56, 160);
  const NODE_H = 36;
  const COL_GAP = 28;
  const ROW_GAP = 50;
  const PAD = 12;

  const cols = layout.maxX + 1;
  const rows = layout.maxDepth + 1;
  const colWidth = NODE_W + COL_GAP;
  const rowHeight = NODE_H + ROW_GAP;
  const width = cols * colWidth + PAD * 2 - COL_GAP;
  const height = rows * rowHeight + PAD * 2 - ROW_GAP;

  const nodeX = (n) => PAD + n.x * colWidth + NODE_W / 2;
  const nodeY = (n) => PAD + n.y * rowHeight + NODE_H / 2;

  // Lines connect parent-bottom to child-top so they don't run through
  // the node body. Pre-compute per child.
  const lines = [];
  for (const n of nodes) {
    if (n.left) {
      lines.push({
        key: `${n.id}-l`,
        x1: nodeX(n),
        y1: nodeY(n) + NODE_H / 2,
        x2: nodeX(n.left),
        y2: nodeY(n.left) - NODE_H / 2,
      });
    }
    if (n.right) {
      lines.push({
        key: `${n.id}-r`,
        x1: nodeX(n),
        y1: nodeY(n) + NODE_H / 2,
        x2: nodeX(n.right),
        y2: nodeY(n.right) - NODE_H / 2,
      });
    }
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", maxWidth: width, height: "auto" }}
      role="img"
      aria-label="Tree diagram"
    >
      <g>
        {lines.map((l) => (
          <line
            key={l.key}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke={accent}
            strokeWidth={1.5}
            opacity={0.55}
          />
        ))}
      </g>
      <g>
        {nodes.map((n) => (
          <TreeNode
            key={n.id}
            x={nodeX(n) - NODE_W / 2}
            y={nodeY(n) - NODE_H / 2}
            w={NODE_W}
            h={NODE_H}
            value={n.value}
            label={n.label}
            accent={accent}
          />
        ))}
      </g>
    </svg>
  );
}

function TreeNode({ x, y, w, h, value, label, accent }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect
        width={w}
        height={h}
        rx={h / 2}
        ry={h / 2}
        fill="#0f172a"
        stroke={accent}
        strokeWidth={1.5}
      />
      <text
        x={w / 2}
        y={h / 2 + 4}
        textAnchor="middle"
        fontSize={value && String(value).length > 8 ? 10 : 12}
        fontWeight={600}
        fill="#e2e8f0"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {String(value ?? "")}
      </text>
      {label ? (
        <text
          x={w / 2}
          y={h + 12}
          textAnchor="middle"
          fontSize={9}
          fill="#94a3b8"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          {String(label)}
        </text>
      ) : null}
    </g>
  );
}

function layoutTree(node) {
  if (!node || typeof node !== "object") return null;
  let counter = 0;
  let maxDepth = 0;
  let nextId = 0;
  function visit(n, depth) {
    if (n == null) return null;
    if (depth > maxDepth) maxDepth = depth;
    const left = visit(n.left || null, depth + 1);
    const x = counter++;
    const right = visit(n.right || null, depth + 1);
    return {
      id: nextId++,
      value: n.value ?? n.key ?? n.label ?? "",
      label: n.label && (n.value !== undefined || n.key !== undefined)
        ? n.label
        : n.note || null,
      x,
      y: depth,
      left,
      right,
    };
  }
  const root = visit(node, 0);
  if (!root) return null;
  root.maxX = counter - 1;
  root.maxDepth = maxDepth;
  return root;
}

function collectNodes(layout, out = []) {
  if (!layout) return out;
  out.push(layout);
  collectNodes(layout.left, out);
  collectNodes(layout.right, out);
  return out;
}

// ── linked list ───────────────────────────────────────────────────────────
// horizontal sequence: [3] → [7] → [12] → NULL

function ListDiagram({ items, terminator, accent }) {
  const list = readItemArray(items);
  if (list.length === 0) return null;

  const NODE_W_BASE = 50;
  const NODE_H = 38;
  const NODE_GAP = 28;
  const PAD = 12;

  const widths = list.map((it) =>
    clamp(estimateTextWidth(it.value) + 18, NODE_W_BASE, 110)
  );
  const totalNodes = widths.reduce((a, b) => a + b, 0);
  const arrowWidth = NODE_GAP * (list.length - 1);
  const TERM_W = terminator
    ? clamp(estimateTextWidth(terminator) + 18, 56, 96)
    : 0;
  const width =
    PAD * 2 +
    totalNodes +
    arrowWidth +
    (terminator ? NODE_GAP + TERM_W : 0);
  const height = PAD * 2 + NODE_H + 22;

  // Compute per-node x-positions.
  const positions = [];
  let cursor = PAD;
  for (let i = 0; i < list.length; i++) {
    positions.push(cursor);
    cursor += widths[i] + NODE_GAP;
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", maxWidth: width, height: "auto" }}
      role="img"
      aria-label="Linked list diagram"
    >
      {/* arrows under-and-between nodes */}
      {list.slice(0, -1).map((_, i) => {
        const x1 = positions[i] + widths[i];
        const x2 = positions[i + 1];
        const y = PAD + NODE_H / 2;
        return (
          <Arrow
            key={`a-${i}`}
            x1={x1 + 4}
            y1={y}
            x2={x2 - 4}
            y2={y}
            accent={accent}
          />
        );
      })}
      {terminator ? (
        <Arrow
          x1={positions[positions.length - 1] + widths[widths.length - 1] + 4}
          y1={PAD + NODE_H / 2}
          x2={
            positions[positions.length - 1] +
            widths[widths.length - 1] +
            NODE_GAP -
            4
          }
          y2={PAD + NODE_H / 2}
          accent={accent}
        />
      ) : null}

      {/* node boxes */}
      {list.map((it, i) => (
        <BoxNode
          key={i}
          x={positions[i]}
          y={PAD}
          w={widths[i]}
          h={NODE_H}
          value={it.value}
          label={it.label}
          accent={accent}
        />
      ))}

      {/* terminator (NULL / nullptr / etc.) */}
      {terminator ? (
        <g
          transform={`translate(${
            positions[positions.length - 1] +
            widths[widths.length - 1] +
            NODE_GAP
          }, ${PAD})`}
        >
          <rect
            width={TERM_W}
            height={NODE_H}
            rx={6}
            ry={6}
            fill="#0f172a"
            stroke={hexAlpha(accent, 0.6)}
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <text
            x={TERM_W / 2}
            y={NODE_H / 2 + 4}
            textAnchor="middle"
            fontSize={11}
            fill="#94a3b8"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
          >
            {terminator}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function BoxNode({ x, y, w, h, value, label, accent }) {
  return (
    <g transform={`translate(${x}, ${y})`}>
      <rect
        width={w}
        height={h}
        rx={6}
        ry={6}
        fill="#0f172a"
        stroke={accent}
        strokeWidth={1.5}
      />
      <text
        x={w / 2}
        y={h / 2 + 4}
        textAnchor="middle"
        fontSize={value && String(value).length > 8 ? 10 : 12}
        fontWeight={600}
        fill="#e2e8f0"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {String(value ?? "")}
      </text>
      {label ? (
        <text
          x={w / 2}
          y={h + 12}
          textAnchor="middle"
          fontSize={9}
          fill="#94a3b8"
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          {String(label)}
        </text>
      ) : null}
    </g>
  );
}

function Arrow({ x1, y1, x2, y2, accent }) {
  // Tiny inline SVG arrow with a head triangle. Head points from
  // (x1,y1) toward (x2,y2). We hand-position rather than using
  // <marker> so the head stays sharp at small sizes and we don't
  // need to register a per-svg defs block.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 7;
  const headW = 4;
  const tipX = x2;
  const tipY = y2;
  const baseX = tipX - ux * headLen;
  const baseY = tipY - uy * headLen;
  const perpX = -uy;
  const perpY = ux;
  const ax = baseX + perpX * headW;
  const ay = baseY + perpY * headW;
  const bx = baseX - perpX * headW;
  const by = baseY - perpY * headW;
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={baseX}
        y2={baseY}
        stroke={accent}
        strokeWidth={1.5}
        opacity={0.7}
      />
      <polygon
        points={`${tipX},${tipY} ${ax},${ay} ${bx},${by}`}
        fill={accent}
        opacity={0.8}
      />
    </g>
  );
}

// ── stack ─────────────────────────────────────────────────────────────────
// vertical column. items[0] is the top.

function StackDiagram({ items, accent }) {
  const list = readItemArray(items);
  if (list.length === 0) return null;

  const NODE_W = clamp(
    Math.max(...list.map((it) => estimateTextWidth(it.value))) + 24,
    72,
    160
  );
  const NODE_H = 32;
  const NODE_GAP = 4;
  const LABEL_W = 80;
  const PAD = 12;
  const width = PAD * 2 + LABEL_W + NODE_W;
  const height = PAD * 2 + list.length * NODE_H + (list.length - 1) * NODE_GAP;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", maxWidth: width, height: "auto" }}
      role="img"
      aria-label="Stack diagram"
    >
      {list.map((it, i) => {
        const y = PAD + i * (NODE_H + NODE_GAP);
        const isTop = i === 0;
        const isBottom = i === list.length - 1;
        return (
          <g key={i}>
            <rect
              x={PAD + LABEL_W}
              y={y}
              width={NODE_W}
              height={NODE_H}
              fill="#0f172a"
              stroke={accent}
              strokeWidth={1.5}
            />
            <text
              x={PAD + LABEL_W + NODE_W / 2}
              y={y + NODE_H / 2 + 4}
              textAnchor="middle"
              fontSize={12}
              fontWeight={600}
              fill="#e2e8f0"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              {String(it.value ?? "")}
            </text>
            {isTop ? (
              <StackPointer
                x={PAD + LABEL_W - 4}
                y={y + NODE_H / 2}
                label="← top"
                accent={accent}
              />
            ) : null}
            {isBottom && !isTop ? (
              <StackPointer
                x={PAD + LABEL_W - 4}
                y={y + NODE_H / 2}
                label="← bottom"
                accent={accent}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

function StackPointer({ x, y, label, accent }) {
  return (
    <text
      x={x}
      y={y + 4}
      textAnchor="end"
      fontSize={11}
      fill={accent}
      fontFamily="ui-sans-serif, system-ui, sans-serif"
    >
      {label}
    </text>
  );
}

// ── queue ─────────────────────────────────────────────────────────────────
// horizontal row. items[0] is the front.

function QueueDiagram({ items, accent }) {
  const list = readItemArray(items);
  if (list.length === 0) return null;
  const NODE_H = 36;
  const NODE_W = clamp(
    Math.max(...list.map((it) => estimateTextWidth(it.value))) + 18,
    50,
    96
  );
  const NODE_GAP = 6;
  const PAD = 12;
  const FRONT_LABEL_W = 70;
  const BACK_LABEL_W = 70;
  const total =
    PAD * 2 +
    FRONT_LABEL_W +
    list.length * NODE_W +
    (list.length - 1) * NODE_GAP +
    BACK_LABEL_W;
  const height = PAD * 2 + NODE_H;

  return (
    <svg
      viewBox={`0 0 ${total} ${height}`}
      style={{ width: "100%", maxWidth: total, height: "auto" }}
      role="img"
      aria-label="Queue diagram"
    >
      <text
        x={PAD}
        y={PAD + NODE_H / 2 + 4}
        fontSize={11}
        fill={accent}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        front →
      </text>
      {list.map((it, i) => (
        <g
          key={i}
          transform={`translate(${
            PAD + FRONT_LABEL_W + i * (NODE_W + NODE_GAP)
          }, ${PAD})`}
        >
          <rect
            width={NODE_W}
            height={NODE_H}
            rx={4}
            ry={4}
            fill="#0f172a"
            stroke={accent}
            strokeWidth={1.5}
          />
          <text
            x={NODE_W / 2}
            y={NODE_H / 2 + 4}
            textAnchor="middle"
            fontSize={12}
            fontWeight={600}
            fill="#e2e8f0"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
          >
            {String(it.value ?? "")}
          </text>
        </g>
      ))}
      <text
        x={
          PAD +
          FRONT_LABEL_W +
          list.length * NODE_W +
          (list.length - 1) * NODE_GAP +
          8
        }
        y={PAD + NODE_H / 2 + 4}
        fontSize={11}
        fill={accent}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        ← back
      </text>
    </svg>
  );
}

// ── graph ─────────────────────────────────────────────────────────────────
// circular layout. Edges drawn first so node circles cover the line endpoints.

function GraphDiagram({ nodes, edges, directed, accent }) {
  const list = (Array.isArray(nodes) ? nodes : []).map((n, i) => {
    if (typeof n === "string") return { id: n, label: n, key: i };
    return {
      id: n.id ?? n.label ?? String(i),
      label: n.label ?? n.id ?? String(i),
      key: i,
    };
  });
  if (list.length === 0) return null;
  const cleanEdges = (Array.isArray(edges) ? edges : []).filter(
    (e) => e && (e.from ?? e.source) && (e.to ?? e.target)
  );

  const RADIUS = clamp(40 + list.length * 8, 80, 140);
  const PAD = 28 + RADIUS / 2;
  const SIZE = (RADIUS + PAD) * 2;
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const NODE_R = clamp(
    Math.max(...list.map((n) => estimateTextWidth(n.label))) / 2 + 14,
    22,
    44
  );

  const positions = list.map((n, i) => {
    // Start at the top (-pi/2) and go clockwise.
    const theta = -Math.PI / 2 + (i * 2 * Math.PI) / list.length;
    return {
      ...n,
      px: cx + RADIUS * Math.cos(theta),
      py: cy + RADIUS * Math.sin(theta),
    };
  });
  const byId = new Map(positions.map((p) => [p.id, p]));

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      style={{
        width: "100%",
        maxWidth: SIZE,
        height: "auto",
      }}
      role="img"
      aria-label="Graph diagram"
    >
      {/* edges */}
      {cleanEdges.map((e, i) => {
        const a = byId.get(e.from ?? e.source);
        const b = byId.get(e.to ?? e.target);
        if (!a || !b) return null;
        // Trim each end of the line by NODE_R so it touches the
        // circle boundary instead of the centre — gives the
        // arrowhead a clean landing for directed graphs.
        const dx = b.px - a.px;
        const dy = b.py - a.py;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const sx = a.px + ux * NODE_R;
        const sy = a.py + uy * NODE_R;
        const ex = b.px - ux * NODE_R;
        const ey = b.py - uy * NODE_R;
        const mx = (sx + ex) / 2;
        const my = (sy + ey) / 2;
        return (
          <g key={i}>
            {directed ? (
              <Arrow x1={sx} y1={sy} x2={ex} y2={ey} accent={accent} />
            ) : (
              <line
                x1={sx}
                y1={sy}
                x2={ex}
                y2={ey}
                stroke={accent}
                strokeWidth={1.5}
                opacity={0.55}
              />
            )}
            {e.weight != null && String(e.weight).trim() !== "" ? (
              <g transform={`translate(${mx}, ${my})`}>
                <rect
                  x={-12}
                  y={-9}
                  width={24}
                  height={14}
                  rx={3}
                  ry={3}
                  fill="#0b1220"
                  stroke={hexAlpha(accent, 0.4)}
                  strokeWidth={1}
                />
                <text
                  x={0}
                  y={2}
                  textAnchor="middle"
                  fontSize={9}
                  fill="#cbd5e1"
                  fontFamily="ui-sans-serif, system-ui, sans-serif"
                >
                  {String(e.weight)}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}
      {/* nodes */}
      {positions.map((p) => (
        <g key={p.id}>
          <circle
            cx={p.px}
            cy={p.py}
            r={NODE_R}
            fill="#0f172a"
            stroke={accent}
            strokeWidth={1.5}
          />
          <text
            x={p.px}
            y={p.py + 4}
            textAnchor="middle"
            fontSize={p.label && String(p.label).length > 6 ? 10 : 12}
            fontWeight={600}
            fill="#e2e8f0"
            fontFamily="ui-sans-serif, system-ui, sans-serif"
          >
            {String(p.label ?? "")}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ── hash table ────────────────────────────────────────────────────────────
// Indexed column on the left, chain of bucket items on the right.

function HashTableDiagram({ buckets, accent }) {
  const cleaned = (Array.isArray(buckets) ? buckets : [])
    .map((b, i) => ({
      index: b.index ?? i,
      items: readItemArray(b.items || []),
    }))
    .slice(0, 12);
  if (cleaned.length === 0) return null;

  const ROW_H = 36;
  const ROW_GAP = 4;
  const INDEX_W = 40;
  const ITEM_W = 70;
  const ITEM_GAP = 6;
  const PAD = 12;
  const longestChain = Math.max(...cleaned.map((b) => b.items.length));
  const width =
    PAD * 2 +
    INDEX_W +
    18 +
    Math.max(longestChain, 1) * (ITEM_W + ITEM_GAP);
  const height = PAD * 2 + cleaned.length * ROW_H + (cleaned.length - 1) * ROW_GAP;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", maxWidth: width, height: "auto" }}
      role="img"
      aria-label="Hash table diagram"
    >
      {cleaned.map((b, i) => {
        const y = PAD + i * (ROW_H + ROW_GAP);
        return (
          <g key={i}>
            <rect
              x={PAD}
              y={y}
              width={INDEX_W}
              height={ROW_H}
              fill="#0f172a"
              stroke={hexAlpha(accent, 0.5)}
              strokeWidth={1}
            />
            <text
              x={PAD + INDEX_W / 2}
              y={y + ROW_H / 2 + 4}
              textAnchor="middle"
              fontSize={11}
              fontWeight={700}
              fill="#94a3b8"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              {String(b.index)}
            </text>

            {b.items.length === 0 ? (
              <text
                x={PAD + INDEX_W + 18}
                y={y + ROW_H / 2 + 4}
                fontSize={11}
                fill="#475569"
                fontStyle="italic"
                fontFamily="ui-sans-serif, system-ui, sans-serif"
              >
                (empty)
              </text>
            ) : (
              b.items.map((it, j) => {
                const x = PAD + INDEX_W + 18 + j * (ITEM_W + ITEM_GAP);
                return (
                  <g key={j}>
                    {j > 0 ? (
                      <Arrow
                        x1={x - ITEM_GAP - 1}
                        y1={y + ROW_H / 2}
                        x2={x - 2}
                        y2={y + ROW_H / 2}
                        accent={accent}
                      />
                    ) : null}
                    <rect
                      x={x}
                      y={y + 4}
                      width={ITEM_W}
                      height={ROW_H - 8}
                      rx={4}
                      ry={4}
                      fill="#0f172a"
                      stroke={accent}
                      strokeWidth={1.5}
                    />
                    <text
                      x={x + ITEM_W / 2}
                      y={y + ROW_H / 2 + 4}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={600}
                      fill="#e2e8f0"
                      fontFamily="ui-sans-serif, system-ui, sans-serif"
                    >
                      {String(it.value ?? "")}
                    </text>
                  </g>
                );
              })
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ── ASCII fallback ────────────────────────────────────────────────────────

function AsciiDiagram({ text }) {
  if (!text) return null;
  return (
    <pre
      style={{
        margin: 0,
        padding: "10px 12px",
        background: "transparent",
        color: "#cbd5e1",
        fontSize: 12,
        lineHeight: 1.45,
        whiteSpace: "pre",
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        textAlign: "left",
        width: "100%",
        overflowX: "auto",
      }}
    >
      {text}
    </pre>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function normaliseKind(rawKind) {
  if (!rawKind) return "ascii";
  const s = String(rawKind).toLowerCase().trim();
  if (s === "linkedlist" || s === "linked-list" || s === "linked list") return "list";
  if (s === "hash-table" || s === "hash table" || s === "map") return "hashtable";
  if (s === "binarytree" || s === "binary-tree" || s === "binary tree") return "tree";
  if (s === "bst" || s === "avl" || s === "heap" || s === "trie" || s === "redblack" || s === "redblacktree" || s === "btree" || s === "b-tree") return "tree";
  return s;
}

function readItemArray(items) {
  if (!Array.isArray(items)) return [];
  return items.map((it) => {
    if (it == null) return { value: "" };
    if (typeof it === "object") {
      return {
        value: it.value ?? it.label ?? it.key ?? it.name ?? "",
        label: it.note || null,
      };
    }
    return { value: String(it) };
  });
}

function readItems(diagram) {
  return diagram.items || diagram.nodes || diagram.values || diagram.elements || [];
}

function readBuckets(diagram) {
  if (Array.isArray(diagram.buckets)) return diagram.buckets;
  // Some LLMs emit `{ "0": ["Alice"], "3": ["Bob"] }` — convert.
  if (diagram.buckets && typeof diagram.buckets === "object") {
    return Object.entries(diagram.buckets).map(([k, v]) => ({
      index: k,
      items: Array.isArray(v) ? v : [v],
    }));
  }
  return [];
}

function estimateTextWidth(text, fontSize = 12) {
  // Char width is roughly 0.55em for sans-serif. Errs on the wide side
  // because it's better to have a too-wide node than a label that
  // overflows the box.
  return Math.ceil(String(text || "").length * fontSize * 0.62);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hexAlpha(color, alpha) {
  // Append an 8-bit alpha to a #rrggbb / #rgb hex string. Falls
  // through unchanged for rgb()/rgba()/named colours since they
  // already accept their own alpha channel via the caller's CSS.
  if (typeof color !== "string" || !color.startsWith("#")) return color;
  const a = Math.round(clamp(alpha, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0");
  if (color.length === 4) {
    // #rgb -> #rrggbbaa
    const r = color[1];
    const g = color[2];
    const b = color[3];
    return `#${r}${r}${g}${g}${b}${b}${a}`;
  }
  if (color.length === 7) return color + a;
  return color;
}
