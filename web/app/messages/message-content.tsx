import parse, {
  domToReact,
  type HTMLReactParserOptions,
  Element,
  type DOMNode,
} from 'html-react-parser';
import { TradeBadge } from './trade-badge';
import { SymbolBadge } from './symbol-badge';
import { QuoteDisplay } from './quote-display';
import type { Message } from '../../../src/db/schema';

function getTextContent(node: DOMNode): string {
  if (node.type === 'text') return (node as unknown as { data: string }).data;
  if (node instanceof Element && node.children) {
    return (node.children as DOMNode[]).map(getTextContent).join('');
  }
  return '';
}

function extractQuote(el: Element): { author?: string; text: string; messageRef?: string } {
  let author: string | undefined;
  let messageRef: string | undefined;
  let text = '';

  for (const child of el.children as DOMNode[]) {
    if (child instanceof Element) {
      // Author from <b data-user="..."> or nested <b><b data-user="...">
      if (child.name === 'b') {
        const dataUser = child.attribs?.['data-user'];
        if (dataUser) {
          author = dataUser;
          continue;
        }
        // Check nested <b data-user>
        for (const nested of child.children as DOMNode[]) {
          if (nested instanceof Element && nested.attribs?.['data-user']) {
            author = nested.attribs['data-user'];
          }
        }
        if (author) continue;
      }
      // Skip bx-icons and View links, but extract messageRef from msglink
      if (child.name === 'i' && child.attribs?.class?.includes('bx')) continue;
      if (child.name === 'a' && child.attribs?.['data-msglink'] !== undefined) {
        const href = child.attribs?.href;
        if (href) {
          const match = href.match(/#m-(\d+)/);
          if (match) messageRef = match[1];
        }
        continue;
      }
      text += getTextContent(child);
    } else {
      text += getTextContent(child);
    }
  }

  // Clean up: strip leading/trailing whitespace plus ": " prefix from "@Author: text" pattern
  text = text.replace(/^[\s:]+/, '').trim();

  return { author, text, messageRef };
}

const options: HTMLReactParserOptions = {
  replace(domNode) {
    if (!(domNode instanceof Element)) return;

    // Skip <html>, <head>, <body> wrappers — just render children
    if (['html', 'head', 'body'].includes(domNode.name)) {
      return <>{domToReact(domNode.children as DOMNode[], options)}</>;
    }

    // Blockquote → QuoteDisplay
    if (domNode.name === 'blockquote') {
      const { author, text, messageRef } = extractQuote(domNode);
      if (!text) return <></>;
      return <div className="py-1.5"><QuoteDisplay author={author} text={text} messageRef={messageRef} /></div>;
    }

    // Badge spans → TradeBadge
    if (
      domNode.name === 'span' &&
      domNode.attribs?.class?.includes('badge')
    ) {
      const label = getTextContent(domNode).trim();
      if (!label) return <></>;
      return <TradeBadge label={label} />;
    }

    // Symbol links → SymbolBadge
    if (domNode.name === 'a' && domNode.attribs?.['data-symbol']) {
      const symbol = domNode.attribs['data-symbol'];
      return <SymbolBadge symbol={symbol} />;
    }

    // Regular links (strip onclick/target, style nicely)
    if (domNode.name === 'a' && domNode.attribs?.href) {
      // Skip internal View/msglink anchors
      if (domNode.attribs['data-msglink'] !== undefined) return <></>;
      const href = domNode.attribs.href;
      // Skip option-stalker internal links
      if (href.startsWith('/option-stalker')) return <></>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-info hover:underline"
        >
          {domToReact(domNode.children as DOMNode[], options)}
        </a>
      );
    }

    // Strip bx-icons (platform cruft)
    if (
      domNode.name === 'i' &&
      domNode.attribs?.class?.includes('bx')
    ) {
      return <></>;
    }

    // Bold
    if (domNode.name === 'b' || domNode.name === 'strong') {
      return (
        <strong className="font-semibold">
          {domToReact(domNode.children as DOMNode[], options)}
        </strong>
      );
    }

    // Italic
    if (domNode.name === 'i' || domNode.name === 'em') {
      return (
        <em className="italic">
          {domToReact(domNode.children as DOMNode[], options)}
        </em>
      );
    }

    // Line breaks
    if (domNode.name === 'br') {
      return <br />;
    }

    // Div → just render children (avoid block nesting issues)
    if (domNode.name === 'div') {
      return <>{domToReact(domNode.children as DOMNode[], options)}</>;
    }

    // Let everything else pass through
    return undefined;
  },
};

export function MessageContent({ message }: { message: Message }) {
  if (!message.rawHtml) {
    return <span>{message.cleanText}</span>;
  }

  try {
    return <>{parse(message.rawHtml, options)}</>;
  } catch {
    return <span>{message.cleanText}</span>;
  }
}
