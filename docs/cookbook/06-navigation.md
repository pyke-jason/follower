# Navigation & Wayfinding

How users move through your app, understand where they are, and switch between scopes.
Every section below answers: what is the user thinking, which components serve that thinking, what happens in plain English, what else you could do, and what goes wrong.

---

## 1. App Shell with Sidebar

**User mental model:** "There is a fixed menu on the left that tells me every major section. I can shrink it when I need more room for content."

**Why a sidebar beats a top nav:**
- You have more than five or six top-level destinations. A horizontal bar runs out of room; a sidebar scrolls.
- Your labels are long or varied in length. Vertical space is forgiving; horizontal space is not.
- You need nested groups (see section 6). Top nav cannot nest without dropdown menus on every item, which feels like a web portal from 2008.

Top nav is better when you have three or four destinations with short labels and no nesting. Do not force a sidebar onto a simple app.

**Components and why:**
- SidebarProvider manages open/collapsed state and keyboard shortcut binding for the whole tree. Wrap your outermost layout in it.
- Sidebar is the container. Set it to icon-collapsible mode so it shrinks to a narrow icon rail instead of disappearing entirely.
- SidebarMenuButton on each nav item. Give every button a tooltip prop so that when the sidebar is collapsed, hovering an icon still reveals the label.
- SidebarRail is the thin vertical strip at the sidebar edge. Users click or drag it to toggle. Without it, the only toggle is the trigger button, which many users never discover.
- SidebarInset wraps your main content area so the layout reflows correctly when the sidebar collapses.
- SidebarTrigger is an explicit hamburger/collapse button. Place it in the top bar for users who do not notice the rail.

**Flow in plain English:**
The app loads with the sidebar expanded. The user sees labeled nav items with icons. They click a destination and the main content area updates. When they want more space, they click the rail or press the keyboard shortcut. The sidebar collapses to a narrow column of icons with tooltips on hover. The header area, if it contained a title or logo, hides its text and shows only an icon or nothing.

**Alternatives:**
- Offcanvas mode: the sidebar slides completely off-screen instead of shrinking to icons. Use this when you want maximum content space and navigation is infrequent.
- Floating variant: sidebar appears with rounded corners and a gap from the viewport edge, giving a card-like feel.
- Right-side placement: rare, but useful for tools where the primary content is on the left and secondary navigation or context is on the right.

**Mistakes to avoid:**
- Forgetting tooltips in icon mode. A column of unlabeled icons is useless to anyone who has not memorized your nav. Every SidebarMenuButton needs a tooltip.
- Hiding the toggle mechanism. If neither the rail nor a trigger button is visible, users have no way to collapse or expand. Include at least one of the two.
- Putting too many items at the top level. If you have fifteen sidebar items, the user cannot scan them. Group them (section 6) or question whether some belong in sub-pages instead.

---

## 2. Breadcrumbs

**User mental model:** "I am somewhere deep in the app. The breadcrumb trail tells me exactly where, and I can jump back to any ancestor."

**Components and why:**
- Breadcrumb and BreadcrumbList form the container and list structure.
- BreadcrumbItem + BreadcrumbLink for each ancestor level. These are clickable -- users jump back by clicking a parent.
- BreadcrumbPage for the final crumb. Not clickable. It represents "you are here."
- BreadcrumbSeparator between items. Defaults to a slash; swap in a chevron icon if you prefer.
- BreadcrumbEllipsis for overflow. When the hierarchy is deep (four or more levels), collapse the middle segments behind an ellipsis.
- DropdownMenu wrapping the ellipsis, so clicking it reveals the hidden middle crumbs in a dropdown list.

**Flow in plain English:**
A three-level path like Home, Traders, Pete renders all three crumbs with separators. The last one is non-clickable. A five-level path renders the first crumb, an ellipsis with a dropdown, and the last two crumbs. Clicking the ellipsis shows the hidden middle levels. Clicking any ancestor crumb navigates directly to that level.

**Handling overflow:**
Pick a visible-tail count (usually two). Always show the root crumb and the last N crumbs. Everything between collapses into the ellipsis dropdown. For very deep hierarchies (six-plus levels), this keeps the breadcrumb bar from wrapping or pushing action buttons off-screen.

**Alternatives:**
- No collapse for short trails. If your app never goes deeper than three levels, skip the ellipsis logic entirely.
- Static ellipsis without a dropdown. Shows the user that levels were omitted without offering a way to reach them. Simpler but less useful.
- Custom separator icon. Chevrons feel more directional than slashes and read better in dense top bars.

**Mistakes to avoid:**
- Making the last crumb clickable. It represents the current page. Clicking it should do nothing, not reload the page.
- Omitting breadcrumbs on pages that have a sidebar. Breadcrumbs and sidebars solve different problems. The sidebar shows the full navigation tree; breadcrumbs show your current position within it. Both are useful on detail pages.
- Hardcoding breadcrumbs per page instead of deriving them from the route. When a route changes, stale breadcrumbs are worse than no breadcrumbs.

---

## 3. Tab-Based Sections

**User mental model:** "I am on one page, looking at different facets of the same thing. Tabs let me flip between views without leaving."

**When tabs are the right choice:**
- The content regions share the same parent entity. A trader's open positions, trade history, and statistics are all facets of that trader.
- Switching should feel instant and lightweight, not like navigating to a new page.
- The URL should not change (or should only update a query parameter, not the path).

When the sections are truly independent pages with their own data, use routes, not tabs. Tabs that secretly load entirely different datasets mislead users into thinking they are viewing related facets.

**Components and why:**
- Tabs wraps everything and manages which panel is visible.
- TabsList renders the row of tab triggers.
- TabsTrigger is each clickable tab label. It pairs with a TabsContent by a shared value string.
- TabsContent is the panel that shows or hides. By default, inactive content unmounts. Use forceMount to keep it in the DOM if you need to preserve scroll position or animation state.

**Flow in plain English:**
The page loads with a default tab selected. The user sees a horizontal row of tab labels. They click a different tab. The current content panel disappears and the new one appears. No URL change, no loading spinner (unless the tab content fetches lazily).

**Alternatives:**
- Vertical tabs (orientation set to vertical). Useful for settings pages where the left side lists categories and the right side shows the active category's content.
- Controlled mode: sync the active tab with URL search params so refreshing or sharing the URL preserves the active tab.
- Underline variant instead of pill/boxed background for a lighter visual style.
- Icon-only tabs for compact spaces, with tooltips for accessibility.

**Mistakes to avoid:**
- Using tabs when you mean routes. If each "tab" has its own URL, its own data, and its own loading state, it is a page, not a tab. Use your router.
- Too many tabs in the bar. Five is a practical limit. Beyond that, the labels get truncated or the bar scrolls horizontally, which defeats the purpose of at-a-glance navigation. Group or rethink.
- Forgetting that inactive tab content unmounts by default. If users fill in a form on one tab, switch to another, and switch back, their input is gone. Use forceMount or lift form state above the tabs.

---

## 4. Responsive Navigation

**User mental model:** On desktop: "The sidebar is always visible and I can work with it open." On mobile: "I tap a menu button and the navigation slides in, then I dismiss it after choosing."

**The built-in approach:**
The Sidebar component already handles responsive behavior. When set to offcanvas collapsible mode, it renders as a persistent sidebar on wide viewports and a Sheet overlay on narrow ones. The useSidebar hook exposes mobile-specific state. A SidebarTrigger in the top bar opens the overlay on mobile. No media-query logic needed in your code.

**When you want a different mobile treatment:**
If a bottom-up Drawer feels more natural for your app (common in mobile-first tools), extract your nav items into a shared data structure. On desktop, render them inside the Sidebar. On mobile, render them inside a Drawer with bottom direction. A media query hook controls which one mounts.

**Flow in plain English (built-in):**
On desktop, the sidebar is visible. On mobile, it is hidden. The user taps the trigger button. The sidebar slides in from the left as a Sheet overlay. They tap a destination. The overlay closes and the content area updates. Alternatively, they swipe or tap outside to dismiss without navigating.

**Flow in plain English (bottom drawer):**
On mobile, the user taps a menu icon in the top bar. A drawer slides up from the bottom of the screen showing nav items. They tap a destination. The drawer closes. The content area updates. They can also drag the drawer down to dismiss it.

**Alternatives:**
- Side drawer instead of bottom drawer: a Drawer with left direction behaves like the built-in Sheet but with drag-to-dismiss.
- Hybrid approach: use the sidebar's built-in isMobile flag for fine-grained conditional rendering within the same component tree, rather than mounting two completely separate components.

**Mistakes to avoid:**
- Rendering both the desktop sidebar and the mobile overlay at the same time. They should be mutually exclusive or the built-in component should handle the switch.
- Forgetting to close the overlay on navigation. If the user taps a link and the drawer stays open over the new content, it feels broken.
- Making the mobile trigger too small or hidden. On mobile, the menu button is the only way in. Make it prominent and place it in a consistent location (top-left corner of the top bar).

---

## 5. Workspace / Project Switching

**User mental model:** "I am working in one context (an account, a team, a project). I can switch to a different context, and everything in the app re-scopes to that context."

**Components and why:**
- SidebarHeader (or SidebarFooter) is the natural home for the switcher. It sits outside the nav items, signaling that it controls scope, not destination.
- SidebarMenuButton displays the current workspace name and icon. It doubles as the dropdown trigger.
- DropdownMenu opens the list of available workspaces. Each DropdownMenuItem shows a workspace with its icon. Selecting one fires a callback that re-scopes the application data.
- DropdownMenuSeparator divides workspaces from utility actions like "Add workspace."

**Flow in plain English:**
The sidebar header shows the current workspace name and a subtle chevron indicating it is interactive. The user clicks it. A dropdown appears listing all their workspaces, with the active one visually indicated. They select a different workspace. The dropdown closes, the header updates to show the new name, and the app's data context changes -- the trades, settings, and all scoped content now reflect the new workspace.

**Alternatives:**
- Account switcher in the footer instead of the header. Same pattern, but positioned at the bottom of the sidebar. Common when the "workspace" is actually a user account, paired with an avatar and a "Sign out" option below the list.
- Combobox for long lists. If there are dozens of workspaces, replace the DropdownMenu internals with a Command (combobox) for type-ahead filtering.
- In icon-collapsed mode, the workspace name and chevron hide automatically. Only the workspace icon remains visible, acting as the trigger.

**Mistakes to avoid:**
- Not giving visual feedback when the workspace changes. If the data re-scopes but the header still shows the old name for a beat, it feels broken. Update the header immediately (optimistically) and let data refetch in the background.
- Nesting the switcher inside the nav items. It is not a destination; it is a scope change. Keep it visually separate -- in the header or footer, not mixed into the menu.
- Forgetting to reset page-level state on switch. If the user was on page 3 of a filtered trades list in workspace A and switches to workspace B, they should land on a clean state, not inherit stale filters and pagination.

---

## 6. Nested Groups in Sidebar

**User mental model:** "The sidebar is organized into sections. I can collapse sections I do not care about right now, leaving only the ones I am actively using."

**When collapsible groups help:**
- You have ten-plus nav items that naturally cluster into three or four categories (Trading, Analysis, Settings).
- Users typically work within one cluster at a time and the other clusters are noise.
- Screen real estate is limited and a flat list would require scrolling.

**When they hurt:**
- You have six or fewer items total. Grouping them adds interaction cost for no benefit.
- Every group is always open. If no user ever collapses a group, the collapse affordance is visual clutter.
- Groups are only one item deep. A section header for a single link is overhead.

**Components and why:**
- Collapsible wraps each group. It manages open/closed state independently per group.
- SidebarGroupLabel becomes the CollapsibleTrigger. Clicking the section header toggles its items. A chevron icon rotates to indicate state.
- SidebarGroupContent is wrapped in CollapsibleContent so it appears and disappears with the toggle.
- For a second level of nesting within a group, SidebarMenuSub contains SidebarMenuSubItem and SidebarMenuSubButton. This gives indented child links under a parent item.

**Flow in plain English:**
The sidebar shows three groups: Trading, Analysis, and Admin. Each has a section header with a chevron. Trading and Analysis are expanded; Admin is collapsed. The user clicks the Admin header. It expands, revealing Settings and Logs. They click the Trading header. It collapses, freeing vertical space. Each group remembers its own state independently.

For two-level nesting: within the Analysis group, "Backtests" has sub-items "Active" and "Archived." Clicking Backtests does not collapse the whole group -- it expands or collapses just that item's children.

**Alternatives:**
- SidebarGroupAction: a small icon button next to the group header (like a "+" to add a new item to that section). Gives power users a shortcut without cluttering the menu items.
- SidebarMenuBadge on individual items to show notification counts or status indicators.
- SidebarMenuSkeleton for loading states when group content is fetched asynchronously.

**Mistakes to avoid:**
- More than two levels of nesting. If you need three, your information architecture is too deep for a sidebar. Rethink the hierarchy or move the third level into the main content area.
- Collapsing groups by default in a way that hides the user's most-used items. Start the most important group expanded. Persist collapse state across sessions if possible.
- Animating collapse/expand slowly. This is high-frequency interaction. Keep animations snappy (under 150ms) or remove them.

---

## 7. Pagination

**User mental model:** "There are too many items to show at once. I can move forward and backward through pages, and I can see roughly how deep the list goes."

**Components and why:**
- Pagination, PaginationContent, and PaginationItem form the structural container.
- PaginationPrevious and PaginationNext are the backward/forward controls. Always present, disabled when at the boundary.
- PaginationLink for each visible page number. The active page is visually highlighted. Users click a number to jump directly.
- PaginationEllipsis for gaps in the number sequence. When there are many pages, show the first page, an ellipsis, a window around the current page, another ellipsis, and the last page.

**Flow in plain English:**
The user sees a list of 250 trades, 25 per page. Below the list, pagination shows: 1, ellipsis, 4, **5**, 6, ellipsis, 10. They are on page 5. They click 6. The list updates to show rows 126-150. The pagination shifts: 1, ellipsis, 5, **6**, 7, ellipsis, 10. They click Previous. They are back on page 5.

**Windowing logic:**
For seven or fewer total pages, show all numbers with no ellipsis. Beyond that, always show the first and last page. Show a window of one page on each side of the current page. Fill gaps with ellipsis. This keeps the control compact at any scale.

**Alternatives:**
- Compact mode: only Previous and Next buttons with a text label like "Page 3 of 12." Good for table footers where horizontal space is tight.
- URL-driven: encode the page number in search params so pagination survives page refresh and allows sharing a link to a specific page.
- Rows-per-page selector: a Select dropdown next to the pagination letting users choose 10, 25, or 50 per page. Reset to page 1 when the page size changes.
- Infinite scroll: replace pagination entirely with a scroll sentinel that triggers the next page fetch as the user nears the bottom. Better for browsing; worse for "I want to jump to page 8."

**Mistakes to avoid:**
- Not disabling Previous on page 1 and Next on the last page. Clicking them should do nothing, not wrap around or error.
- Resetting scroll position inconsistently. When the user changes pages, scroll the list container to the top. Leaving them at the bottom of the previous page is disorienting.
- Showing pagination when there is only one page. If the total fits on one page, hide the pagination controls entirely.

---

## 8. Top Bar Composition

**User mental model:** "The bar at the top of the content area tells me where I am (left side) and gives me quick actions (right side)."

**Components and why:**
- SidebarTrigger on the far left if the app uses a sidebar. It is the hamburger button that toggles the sidebar.
- Separator (vertical) between the trigger and the breadcrumbs, creating a visual break.
- Breadcrumb trail showing the current location in the hierarchy (see section 2).
- Button group on the right side for page-level actions (Export, New Trade, etc.). Primary action gets the default variant; secondary actions get outline or ghost.

**Flow in plain English:**
The user lands on the Trades page. The top bar shows: sidebar toggle, a vertical line, breadcrumbs reading "Home / Trades", and on the right, an Export button (outline) and a New Trade button (primary). They click New Trade. A dialog or new page opens. On a detail page, the breadcrumbs extend: "Home / Trades / AAPL #42", and the right side might show Edit and Delete buttons instead.

**What goes in the top bar vs. elsewhere:**
- Top bar: location context (breadcrumbs), page-level actions that apply to the whole view, the sidebar trigger.
- Not top bar: row-level actions (those belong in table rows or context menus), filters (those go between the top bar and the content), tabs (those go below the top bar).

**Alternatives:**
- Search in the top bar: place an input with a search icon between the breadcrumbs and the action buttons. Useful for apps where global search is a primary workflow.
- Overflow actions: when there are many page-level actions, replace the button row with a DropdownMenu triggered by a "More" button.
- Sticky top bar: pin it to the top of the scroll area so it remains visible as the user scrolls down long content. Set a z-index so it layers above content.
- Top bar plus tabs: stack the top bar above a TabsList for pages that combine hierarchy context with tab navigation. The top bar shows where you are in the app; the tabs show which facet of the current page you are viewing.

**Mistakes to avoid:**
- Overloading the top bar with too many elements. If it has a trigger, breadcrumbs, a search field, five buttons, and a user avatar, it is a toolbar, not a header. Move secondary items elsewhere.
- Inconsistent top bar height across pages. Pick a height (commonly 48px) and stick to it app-wide. Varying heights make the layout feel unpolished.
- Duplicating actions. If the top bar has an "Export" button and the table also has an export option in a context menu, the user encounters the same action in two places and wonders if they do the same thing. Pick one location.
