// Small inline SVG flags for the book switcher -- deliberately not emoji flags, which have a
// real history of rendering as plain two-letter country-code text instead of an actual flag on
// some Windows configurations. Simplified at this size (no 50 stars on the US flag, no spoked
// Ashoka Chakra on India's, no literal olive-branch/world-map on the UN emblem) since none of
// that detail survives at a ~16px badge anyway -- each still reads correctly via its color
// pattern alone.
export function CountryFlag({ book }: { book: "us" | "india" | "gr" }) {
  if (book === "us") {
    return (
      <span className="book-switcher-flag" aria-hidden="true">
        <svg viewBox="0 0 20 14" xmlns="http://www.w3.org/2000/svg">
          <rect width="20" height="14" fill="#B22234" />
          <rect y="2" width="20" height="2" fill="#fff" />
          <rect y="6" width="20" height="2" fill="#fff" />
          <rect y="10" width="20" height="2" fill="#fff" />
          <rect width="8" height="8" fill="#3C3B6E" />
        </svg>
      </span>
    );
  }
  if (book === "india") {
    return (
      <span className="book-switcher-flag" aria-hidden="true">
        <svg viewBox="0 0 20 14" xmlns="http://www.w3.org/2000/svg">
          <rect width="20" height="14" fill="#fff" />
          <rect width="20" height="4.67" fill="#FF9933" />
          <rect y="9.33" width="20" height="4.67" fill="#138808" />
          <circle cx="10" cy="7" r="1.6" fill="none" stroke="#000080" strokeWidth="0.35" />
          <circle cx="10" cy="7" r="0.3" fill="#000080" />
        </svg>
      </span>
    );
  }
  // "gr" -- GR Books is the consolidated cross-book view (US + India), so a national flag would
  // misrepresent it as one country's book; the UN flag's light-blue field reads as "multi-nation/
  // consolidated" the same way it's used to represent international scope elsewhere.
  return (
    <span className="book-switcher-flag" aria-hidden="true">
      <svg viewBox="0 0 20 14" xmlns="http://www.w3.org/2000/svg">
        <rect width="20" height="14" fill="#5B92E5" />
        <circle cx="10" cy="7" r="4.2" fill="none" stroke="#fff" strokeWidth="0.6" />
        <circle cx="10" cy="7" r="1" fill="#fff" />
      </svg>
    </span>
  );
}
