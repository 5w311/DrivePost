// Pages are stamped with the version they were built from, and ask for their
// scripts and styles by that version. A browser that brings a page back from
// its own saved copy (as car browsers do when reopened) then has a page that
// knows it is old, and reloads itself once it hears the server's version.
export function stampPage(html, version) {
  return html
    .replace(/<html\b/, `<html data-version="${version}"`)
    .replace(/((?:src|href)="\/static\/[^"?]+\.(?:js|css))"/g, `$1?v=${version}"`);
}
