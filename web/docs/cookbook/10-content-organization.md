# Content Organization & Layout

A decision guide for structuring page content. Each section describes the user intent, which components to reach for and why, how the experience flows, what the alternatives are, and what goes wrong when you pick the wrong pattern.

---

## 1. Dashboard Card Grid

**When this comes up:** The user lands on a page and needs to absorb several distinct pieces of information at once -- trader summaries, backtest results, channel status, recent activity. The data is heterogeneous (different shapes per card) and the count is relatively small (4-20 items).

**User mental model:** A bulletin board. Each card is an independent unit the user scans visually. They are not comparing rows in a table -- they are skimming tiles to find the one that needs attention.

**Components and why:**
- Card (with CardHeader, CardTitle, CardDescription, CardContent) -- each tile is self-contained with a title, optional subtitle, and a body. Card provides the visual boundary that makes scanning work.
- CSS grid (not a component, but the layout mechanism) -- responsive columns that reflow automatically. One column on mobile, two on tablets, three or four on desktop.

**How it flows:**
The page renders a grid container. Each item maps to a Card. The grid handles column count via responsive breakpoints. Cards do not know or care how many siblings they have.

**Alternatives:**
- If every card has the same shape and the user is comparing values across items, a Table is better. Cards waste space when the data is uniform.
- If the count is very large (50+), cards do not scale. Switch to a table with pagination or virtual scroll.
- If you only have 2-3 items and they represent a clear left/right or primary/secondary split, a two-column grid with explicit sizing beats an auto-flowing card grid.

**Mistakes to avoid:**
- Mixing wildly different card heights in the same grid. The grid aligns to the tallest card in each row, creating awkward whitespace. Keep card content roughly uniform or use a masonry approach.
- Using cards when you really need a metric strip. Four numbers with labels do not need four full-height cards -- see section 6.
- Forgetting the empty state. When the grid has zero items, show an Empty component, not a blank page.
- Making every card clickable without a visual affordance. If cards navigate somewhere, they need hover states and cursor changes.

---

## 2. Collapsible Sections

**When this comes up:** A page has secondary or advanced content that most users skip. Settings pages with "Advanced options," form sections that only power users need, or progressive disclosure where you show the summary and hide the details.

**User mental model:** A drawer or a folded letter. The user sees the heading, decides if they care, and opens it only when they need to. The default state (open or closed) is a design decision that communicates importance.

**Components and why:**
- Collapsible (with CollapsibleTrigger and CollapsibleContent) -- a single toggle for a single content region. Simpler than Accordion because there is no concept of "items" or mutual exclusion.
- Button (ghost variant) as the trigger -- provides a clickable region with a chevron icon that rotates to signal state.

**How it flows:**
The trigger sits inline with the page content, usually styled as a full-width ghost button with text on the left and a chevron on the right. Clicking it reveals or hides the content region below. The content animates open smoothly.

**Alternatives:**
- If you have multiple collapsible sections and they form a list (FAQ, settings groups), use Accordion instead. Collapsible is for one-off regions; Accordion is for repeating groups.
- If the hidden content is an entirely different view (not just "more of the same"), consider Tabs or route-based navigation instead. Collapsible should feel like revealing detail, not switching context.
- If the section should always be visible but can be made smaller, a resizable panel (section 4) may be more appropriate.

**Mistakes to avoid:**
- Defaulting to closed when the content is essential for first-time users. If 80% of users need to open it, it should start open.
- Nesting collapsibles more than one level deep. Two levels of folding creates a confusing hierarchy. If you need that much nesting, rethink the information architecture.
- Using Collapsible for content that the user needs to compare side-by-side. If they have to keep opening and closing sections to cross-reference, the layout is wrong.

---

## 3. FAQ / Help Content

**When this comes up:** The page presents a list of questions and answers, help topics, or grouped explanation blocks where each item has a title and expandable detail. Common in help pages, onboarding flows, and settings documentation.

**User mental model:** A stack of labeled envelopes. The user reads the titles (questions), finds the one relevant to them, and opens it. They expect to see all titles at once so they can scan quickly.

**Components and why:**
- Accordion (with AccordionItem, AccordionTrigger, AccordionContent) -- purpose-built for this exact pattern. Manages open/close state across multiple items with a single API.

**Single vs. multi-expand -- when to pick which:**
- Single expand (one item open at a time, opening one closes the previous): Best when items are long and the user is looking for one specific answer. Prevents the page from becoming an overwhelming wall of text.
- Multi-expand (any number of items can be open simultaneously): Best when items are short and the user might want to cross-reference two or three answers at once.

**How it flows:**
Items stack vertically. Each trigger shows the question text with an animated chevron. Clicking a trigger toggles its content panel. In single mode, the previously open item closes automatically. The Accordion can start with a default item open (useful for the most common question).

**Alternatives:**
- If the "answers" are very short (one sentence), a list with inline text is simpler. Accordion adds interaction cost -- only use it when the answers are long enough that hiding them meaningfully reduces page length.
- If you have grouped FAQ sections (e.g., "Account," "Billing," "Technical"), use a heading and Separator between groups, with a separate Accordion inside each group.
- If the content is a step-by-step guide rather than Q&A, a Stepper or numbered list is more appropriate than Accordion.

**Mistakes to avoid:**
- Using single-expand mode with only two items. If there are only two items, the user probably wants both visible. Use multi-expand or just show them both open.
- Putting critical information inside an Accordion that most users will never expand. If users need to see it, it should not be hidden behind a click.
- Accordion items with one-word answers. If the content is that short, skip the Accordion and use a definition list or table.

---

## 4. Multi-Pane Resizable Layout

**When this comes up:** The user works with two or three related views simultaneously -- a list and a detail panel, a file tree and an editor, a message list and a compose area. They need to see both at once and want control over how much space each gets. This is the IDE-style layout.

**User mental model:** Windows on a desktop that share the screen. The user drags dividers to allocate space based on their current task. When writing, they make the editor panel wider. When browsing, they make the list wider.

**Components and why:**
- ResizablePanelGroup -- the container that manages the layout direction (horizontal or vertical) and the drag handles between panels.
- ResizablePanel -- each section of the layout. Configured with default, minimum, and maximum sizes as percentages.
- ResizableHandle -- the draggable divider between panels. Can show a visible grab handle or be a minimal line.
- ScrollArea -- placed inside each panel so that each section scrolls independently. Without this, content overflow breaks the layout.

**How it flows:**
The panel group fills the available space (typically full viewport height). Panels divide that space according to their default percentages. The user drags handles to resize. Each panel contains a ScrollArea so its content scrolls independently of siblings. Panels can be nested: a horizontal group can contain a panel that itself holds a vertical group (editor on top, terminal on bottom).

**When this beats tabs or routing:**
- Use resizable panels when the user needs to see both views simultaneously and cross-reference between them.
- Use tabs when the views are alternatives (the user works in one at a time) and screen space is limited.
- Use route-based navigation when the views are independent workflows that do not need to coexist on screen.

**Alternatives:**
- If the detail panel is only needed occasionally, a Sheet (slide-over panel) or Dialog avoids the permanent screen split.
- If the user does not need to resize, a fixed-proportion grid layout is simpler and avoids the complexity of drag state.
- On mobile, resizable panels do not work. Collapse to tabs, a stacked layout, or a drill-down navigation pattern.

**Mistakes to avoid:**
- Forgetting minimum and maximum size constraints. Without them, users can drag a panel to zero width, effectively losing content with no way to recover.
- Not putting ScrollArea inside each panel. If a panel's content overflows without its own scroll container, it pushes sibling panels off screen.
- Using resizable panels for a simple sidebar. If the sidebar never needs to resize, a fixed-width aside with CSS is simpler and more predictable.
- Nesting more than two levels of panel groups. The interaction becomes confusing and the handles compete for drag targets.

---

## 5. Custom Scrollable Regions

**When this comes up:** A section of the page has a fixed height and its content overflows -- a chat message list, a log viewer, a sidebar navigation list, or a horizontal strip of tags. You want a consistent scrollbar appearance across browsers and sometimes need both horizontal and vertical scrolling.

**User mental model:** A window into a larger surface. The user knows there is more content and can scroll to reach it. The scrollbar is a visual hint that the container is bounded.

**Components and why:**
- ScrollArea -- replaces the native scrollbar with a styled one. Provides consistent appearance across browsers (native scrollbars vary dramatically between macOS, Windows, and Linux).
- ScrollBar -- an explicit component for controlling scroll direction. The default is vertical. Add a horizontal ScrollBar when content extends sideways.
- Separator -- often used inside scroll regions to visually divide items in a list.

**When ScrollArea adds value over native scroll:**
- When scrollbar appearance matters for visual consistency (dashboards, polished UIs).
- When you need both horizontal and vertical scrolling with styled scrollbars.
- When the scroll region is inside a resizable panel and needs to behave correctly as the panel size changes.

**When native scroll is fine:**
- Full-page scroll (just let the body scroll).
- Content that rarely overflows. Adding ScrollArea to something that almost never scrolls adds complexity for no benefit.
- Mobile-first views where native momentum scrolling and touch behavior should not be interfered with.

**Alternatives:**
- For horizontal-only scrolling of a small number of items (tags, tabs), native overflow-x-auto with hidden scrollbar is often simpler.
- For very long lists (thousands of items), use virtual scrolling instead. ScrollArea renders all items in the DOM -- it does not virtualize.

**Mistakes to avoid:**
- Putting a ScrollArea inside another ScrollArea. Nested scroll regions create confusing behavior where the user does not know which region will scroll.
- Not setting an explicit height on the ScrollArea container. Without a height constraint, the ScrollArea expands to fit its content and never actually scrolls.
- Using ScrollArea for the main page content. The body should scroll natively; ScrollArea is for bounded regions within the page.

---

## 6. Metric Strips / KPI Rows

**When this comes up:** The top of a dashboard or detail page shows 3-6 key numbers with labels -- total trades, win rate, P&L, open positions. The user glances at these to assess overall status before diving into details below.

**User mental model:** A scoreboard or a car dashboard gauge cluster. Dense, numeric, and scannable in under two seconds. This is not a place for paragraphs or complex visualizations -- just numbers.

**Components and why:**
- Card (compact variant) -- each metric is a small card with a label in CardHeader and the value in CardContent. The card boundary helps the eye separate adjacent metrics.
- CSS grid -- typically four columns on desktop, two on tablets, two or one on mobile. The grid ensures consistent spacing.

**How it flows:**
A horizontal row of compact cards sits at the top of the page. Each card shows: a muted label (small text), a large bold value, and optionally a trend indicator (delta or arrow showing direction). The row is the first thing the user sees and sets context for everything below it.

**Alternatives:**
- If you have more than 6 metrics, the strip becomes overwhelming. Group them into categories and use collapsible sections or tabs to organize them.
- If the metrics need sparklines or mini-charts, you are building a dashboard widget, not a metric strip. Use full-size cards with embedded visualizations instead.
- For inline metadata within a paragraph or header (not a full-width row), use vertical Separators between text spans rather than cards. Example: "12 trades | 63% win rate | $1,284 P&L" as a single line with separators.

**Mistakes to avoid:**
- Making metric cards too large. KPI rows should be compact. If each card is taller than two lines of content, it is taking up too much vertical space before the user reaches the actual content.
- Showing too many decimal places or overly precise numbers. Dashboards are for trends and magnitudes, not precision. Round aggressively.
- Forgetting color semantics. Positive P&L should be green, negative should be red. A metric strip without color coding forces the user to mentally parse sign characters.
- Using full-size cards with descriptions and footers for what should be a glanceable number. Strip the chrome down to label + value + optional delta.

---

## 7. Media Galleries

**When this comes up:** The page displays a collection of images, screenshots, or media thumbnails. The user browses through them, and maintaining consistent aspect ratios prevents layout jank as images of different native sizes load.

**User mental model:** A photo album or filmstrip. The user expects to flip through items sequentially or scan a grid of thumbnails. They expect images to be uniformly sized, not jumping around as they load.

**Components and why:**
- Carousel (with CarouselContent, CarouselItem, CarouselPrevious, CarouselNext) -- provides horizontal browsing with previous/next controls and swipe support. Best for sequential browsing of a moderate number of items (5-30).
- AspectRatio -- wraps each image to enforce a consistent width-to-height ratio regardless of the image's native dimensions. Prevents layout shift during loading.

**How it flows:**
For a browsable gallery, each CarouselItem contains an AspectRatio wrapper around the image. The Carousel provides navigation buttons and optional swipe/drag. For a static grid, skip the Carousel and use a CSS grid of AspectRatio-wrapped images.

**Alternatives:**
- For 1-3 images, a simple grid with AspectRatio is better than a Carousel. Carousels add interaction overhead -- do not use them when all items fit on screen simultaneously.
- For large galleries (100+), consider a virtualized grid or lazy-loaded thumbnails. Carousel loads all items into the DOM.
- If the user needs to select or manage images (upload, delete, reorder), a grid with selection checkboxes is more appropriate than a carousel.

**Mistakes to avoid:**
- Not using AspectRatio when images come from user input or external sources. Without enforced ratios, differently-sized images cause the layout to shift as they load.
- Auto-playing carousels. They frustrate users who are trying to read content near the carousel. Always let the user control navigation.
- Hiding the slide count. If there are 20 items in a carousel, the user needs to know. Show a counter ("3 of 20") or dot indicators.
- Using a carousel for a single image. That is just an image with unnecessary chrome around it.

---

## 8. Visual Grouping

**When this comes up:** A page has multiple logical sections that need visual hierarchy -- settings categories, profile sections, form groups. The content is not a list of identical items (that would be a table or card grid) but rather distinct groups that need separation.

**Components and why:**
- Separator -- a horizontal or vertical line that creates a visual break between sections. Lightweight and does not add structural weight. Best for adjacent sections within a single container.
- Card -- a bordered, elevated container that groups related content. Creates stronger visual separation than a Separator. Best when groups need to feel like distinct units.
- Whitespace (not a component) -- vertical spacing between sections. The lightest form of grouping. Works when the content structure is clear enough that lines and borders are unnecessary.

**Decision tree for choosing a grouping mechanism:**
- Sections within a single form or settings page, where content flows vertically: Separator between groups.
- Distinct, self-contained blocks that could be rearranged independently: Card per group.
- Tight inline metadata values that need separation: vertical Separator between spans.
- Sections that are already clearly differentiated by headers and content type: whitespace alone.
- A divider with a label ("OR," "Advanced," a date heading): a labeled separator pattern using two Separator lines with text between them.

**Alternatives:**
- Tabs can replace visual grouping when the sections are long enough that putting them all on one page creates excessive scrolling.
- Collapsible sections (section 2) can replace Separators when you want to let users hide groups they do not care about.

**Mistakes to avoid:**
- Using both Cards and Separators for the same level of hierarchy. Pick one. Cards inside a page, with Separators inside those Cards, gives two levels. Separators between Cards and also between items within Cards gives confused hierarchy.
- Over-separating. Not every paragraph break needs a Separator. Use them sparingly or they lose their structural meaning.
- Using Cards for every group on a page. If every section is in a Card, the cards stop providing visual differentiation because there is no contrast between "in a card" and "not in a card."

---

## 9. Responsive Layout Strategies

**When this comes up:** The layout needs to work across desktop, tablet, and mobile. Content that sits in a multi-column grid on desktop needs to reorganize into a single-column stack on mobile without losing usability.

**User mental model:** The user does not think about responsive design. They expect the page to "just work" on their device. Content should be reachable, readable, and interactive at every viewport width.

**Key transitions and when they apply:**

**Card grid to stacked list:** On desktop, items appear in a 2-4 column card grid. On mobile, the grid collapses to a single column. Each card becomes a full-width row. This is the simplest responsive pattern and works for most dashboard and listing pages. The cards themselves do not change -- only the grid column count adjusts.

**Side-by-side to stacked:** A two-panel layout (list + detail, form + preview) sits side-by-side on desktop. On mobile, the panels stack vertically or the detail view becomes a separate route or Dialog. This applies to resizable panels, split views, and master-detail layouts.

**Horizontal strip to wrapped grid:** A row of metric cards or action buttons overflows horizontally on mobile. Two strategies: wrap to multiple rows (grid approach), or allow horizontal scrolling (ScrollArea with horizontal ScrollBar). Wrapping is usually better for content the user needs to see; scrolling is acceptable for content the user browses.

**Table to card list:** Wide tables with many columns become unusable on narrow screens. The mobile alternative is to convert each row into a Card that stacks the column values vertically. This requires a separate mobile layout component, not just CSS breakpoints.

**Hide and reveal:** Some content is secondary and can be hidden on mobile entirely. Use responsive utility classes to hide descriptions, secondary columns, or decorative elements on small screens. This is a last resort -- only hide content that is genuinely optional, not content the user needs.

**Alternatives:**
- If the page is primarily used on desktop (an internal tool, an admin panel), do not over-invest in mobile layouts. A reasonable single-column fallback is sufficient.
- If the content is fundamentally tabular (many columns, comparison-oriented), horizontal scrolling on the table is often better than restructuring into cards. Users understand sideways-scrolling tables.

**Mistakes to avoid:**
- Designing only for desktop and assuming responsive "just works." Test every page at 375px width (mobile) during development.
- Hiding critical content on mobile. If the user needs it on desktop, they probably need it on mobile too.
- Using fixed pixel widths for containers or columns. Percentage-based and viewport-relative sizing adapts; fixed pixels break.
- Forgetting touch targets. Buttons and interactive elements need to be at least 44px tall on mobile. Desktop-sized click targets are too small for fingers.
- Making all text smaller on mobile. The text should stay the same size or get larger. Reduce content volume instead.

---

## Quick Reference: Choosing a Layout Pattern

| User intent | First choice | Consider instead when... |
|---|---|---|
| Scan 4-20 heterogeneous summaries | Card grid (1) | Items are uniform -- use Table |
| Hide advanced or secondary content | Collapsible (2) | Multiple collapsibles -- use Accordion (3) |
| Browse Q&A or help topics | Accordion (3) | Answers are one sentence -- use a list |
| Work in two views simultaneously | Resizable panels (4) | Views are alternatives -- use Tabs |
| Bounded scrollable region | ScrollArea (5) | Full-page scroll -- use native |
| Glanceable numeric overview | Metric strip (6) | More than 6 metrics -- group with Tabs |
| Browse a media collection | Carousel + AspectRatio (7) | Under 4 items -- use a grid |
| Separate page sections | Separator / Card / whitespace (8) | Sections are long -- use Tabs |
| Adapt layout to screen size | Responsive grid (9) | Desktop-only tool -- minimal mobile |
