import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Strip markdown syntax for plain text previews (truncated content).
 * Removes: bold, italic, headers, links, inline code, strikethrough.
 */
export function stripMarkdown(text: string): string {
  return text
    // Remove bold/italic (***text***, **text**, *text*, ___text___, __text__, _text_)
    .replace(/(\*{1,3}|_{1,3})([^*_]+)\1/g, '$2')
    // Remove headers (# Header)
    .replace(/^#{1,6}\s+/gm, '')
    // Remove links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove inline code `code`
    .replace(/`([^`]+)`/g, '$1')
    // Remove strikethrough ~~text~~
    .replace(/~~([^~]+)~~/g, '$1')
    // Remove remaining markdown characters
    .replace(/[*_~`#]/g, '')
    // Clean up extra whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

interface MarkdownContentProps {
  content: string
  className?: string
  /** Compact mode for smaller text areas */
  compact?: boolean
}

function cn(...inputs: (string | boolean | undefined)[]) {
  return twMerge(clsx(inputs))
}

export function MarkdownContent({
  content,
  className,
  compact = false
}: MarkdownContentProps) {
  return (
    <div
      className={cn(
        // Base size: 16px `prose` (NOT the crushed 14px `prose-sm`) on a
        // constrained ~66ch measure for comfortable reading — never the
        // edge-to-edge `max-w-none` that made the reading feel squashed.
        'prose max-w-[66ch]',
        // Dark theme overrides using design tokens
        'prose-invert',
        // Headings — manuscript display face, clear rhythm above/below
        'prose-headings:font-display prose-headings:font-semibold prose-headings:text-text-primary',
        'prose-h2:text-xl prose-h2:mt-6 prose-h2:mb-3',
        'prose-h3:text-lg prose-h3:mt-5 prose-h3:mb-2',
        // Paragraphs — body color at the relaxed 1.75 line-height token,
        // generous vertical rhythm so lines breathe.
        'prose-p:text-text-body prose-p:leading-[1.75] prose-p:my-4',
        // Strong/bold
        'prose-strong:text-text-primary prose-strong:font-semibold',
        // Emphasis/italic - using secondary text color
        'prose-em:text-text-secondary prose-em:italic',
        // Lists — body color, relaxed leading, breathing space between items
        'prose-ul:text-text-body prose-ol:text-text-body prose-ul:my-4 prose-ol:my-4',
        'prose-li:text-text-body prose-li:leading-[1.75] prose-li:my-1.5 prose-li:pl-1',
        // List markers - using accent gold (brass)
        'prose-li:marker:text-accent-gold',
        // Blockquotes — brass left rule, hushed parchment
        'prose-blockquote:border-l-accent-gold prose-blockquote:text-text-secondary prose-blockquote:not-italic',
        // Links - using accent purple with smooth animation
        'prose-a:text-accent-purple prose-a:no-underline',
        'prose-a:transition-colors prose-a:duration-150',
        'hover:prose-a:text-accent-gold hover:prose-a:underline',
        // Code blocks - using accent gold for inline code
        'prose-code:text-accent-gold prose-code:bg-background-darker prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded-sm',
        // Pre blocks - using darkest background; scroll long code lines and
        // break long inline tokens/URLs so they never overflow a 390px column.
        'prose-pre:bg-background-darkest prose-pre:border prose-pre:border-ui-border-dark',
        'prose-pre:overflow-x-auto break-words',
        // Compact mode — tighter vertical rhythm, but still 16px and readable
        // (NOT prose-sm). Used inside dense cards/disclosures.
        compact && 'prose-p:my-2.5 prose-ul:my-2.5 prose-ol:my-2.5 prose-h2:mt-4 prose-h3:mt-3',
        className
      )}
    >
      <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{content}</ReactMarkdown>
    </div>
  )
}
