/**
 * Integration tests for sequence diagrams — end-to-end parse → layout → render.
 */
import { describe, it, expect } from 'bun:test'
import { renderMermaidSVG } from '../index.ts'

describe('renderMermaidSVG – sequence diagrams', () => {
  it('renders a basic sequence diagram to valid SVG', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      Alice->>Bob: Hello
      Bob-->>Alice: Hi there`)
    expect(svg).toContain('<svg')
    expect(svg).toContain('</svg>')
    expect(svg).toContain('Alice')
    expect(svg).toContain('Bob')
    expect(svg).toContain('Hello')
  })

  it('renders participant declarations', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      participant A as Alice
      participant B as Bob
      A->>B: Message`)
    expect(svg).toContain('Alice')
    expect(svg).toContain('Bob')
    expect(svg).toContain('Message')
  })

  it('renders actor circle-person icons', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      actor U as User
      participant S as System
      U->>S: Click`)
    // Actors use the circle-person icon (three paths inside a scaled <g>)
    expect(svg).toContain('<g transform="translate(')
    expect(svg).toContain('scale(')
    expect(svg).toContain('User')
    expect(svg).toContain('System')
  })

  it('renders dashed return arrows', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      A->>B: Request
      B-->>A: Response`)
    // Dashed lines have stroke-dasharray
    expect(svg).toContain('stroke-dasharray')
    expect(svg).toContain('Request')
    expect(svg).toContain('Response')
  })

  it('renders loop blocks', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      A->>B: Start
      loop Every 5s
        A->>B: Ping
      end`)
    expect(svg).toContain('loop')
    expect(svg).toContain('Every 5s')
  })

  it('renders alt/else blocks', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      A->>B: Request
      alt Success
        B->>A: 200
      else Error
        B->>A: 500
      end`)
    expect(svg).toContain('alt')
    expect(svg).toContain('Success')
    // Else divider (dashed line)
    expect(svg).toContain('Error')
  })

  it('renders rect color block with translucent fill and no tab label', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      A->>B: Setup
      rect rgb(255, 250, 230)
        A->>B: Inside
      end`)
    // The color is applied as a fill on the block rect.
    expect(svg).toContain('data-type="rect"')
    expect(svg).toContain('fill="rgb(255, 250, 230)"')
    // No tab label of the form "rect [rgb(...)]" — that would mean the
    // RGB triple is being rendered as visible text instead of as a fill.
    expect(svg).not.toContain('rect [rgb(255, 250, 230)]')
  })

  it('renders rect color block accepting rgba, hex, and named colors', () => {
    const rgba = renderMermaidSVG(`sequenceDiagram
      A->>B: m
      rect rgba(10, 20, 30, 0.5)
        A->>B: n
      end`)
    expect(rgba).toContain('fill="rgba(10, 20, 30, 0.5)"')

    const hex = renderMermaidSVG(`sequenceDiagram
      A->>B: m
      rect #fff5e6
        A->>B: n
      end`)
    expect(hex).toContain('fill="#fff5e6"')

    const named = renderMermaidSVG(`sequenceDiagram
      A->>B: m
      rect lightblue
        A->>B: n
      end`)
    expect(named).toContain('fill="lightblue"')
  })

  it('falls back to labeled-tab rendering when rect color is unparseable', () => {
    // A bare `rect` with no color and no other recognizable form should still
    // render the block (with a tab) rather than vanish silently.
    const svg = renderMermaidSVG(`sequenceDiagram
      A->>B: m
      rect not-a-color(garbage
        A->>B: n
      end`)
    expect(svg).toContain('data-type="rect"')
    // Falls back to the labeled tab.
    expect(svg).toContain('rect [not-a-color(garbage]')
  })

  it('renders notes', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      A->>B: Hello
      Note right of B: Think about response
      B-->>A: Hi`)
    expect(svg).toContain('Think about response')
  })

  it('renders with dark colors', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      A->>B: Hello`, { bg: '#18181B', fg: '#FAFAFA' })
    expect(svg).toContain('--bg:#18181B')
  })

  it('renders lifeline dashed lines', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      A->>B: Hello`)
    // Lifelines are dashed vertical lines
    const dashedLines = svg.match(/stroke-dasharray="6 4"/g)
    expect(dashedLines).toBeTruthy()
    expect(dashedLines!.length).toBeGreaterThanOrEqual(2) // at least 2 lifelines
  })

  it('renders a complex authentication flow', () => {
    const svg = renderMermaidSVG(`sequenceDiagram
      participant C as Client
      participant S as Server
      participant DB as Database
      C->>S: POST /login
      S->>DB: SELECT user
      alt User found
        DB-->>S: User record
        S-->>C: 200 OK + token
      else Not found
        DB-->>S: null
        S-->>C: 401 Unauthorized
      end`)
    expect(svg).toContain('<svg')
    expect(svg).toContain('Client')
    expect(svg).toContain('Server')
    expect(svg).toContain('Database')
    expect(svg).toContain('POST /login')
  })
})
