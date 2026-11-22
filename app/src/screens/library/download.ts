// Downloading Library files from their URLs (row 64). Each link carries `download`: the URL is same-origin, so the browser
// saves what comes back and never navigates the app away, even when the answer is a 404 (a file someone else deleted)
// or a sign-in page (a lapsed session); one failing file doesn't stop the others.

/** What a download link needs: an `<a>` in the browser, a stand-in in a test. */
export interface DownloadLink { href: string; download: string; rel: string; click(): void }

export function downloadAll(urls: readonly string[], link: () => DownloadLink = () => document.createElement('a')): void {
  for (const url of urls) {
    const a = link()
    a.href = url
    // An empty value keeps the server's own name (`Content-Disposition`).
    a.download = ''
    a.rel = 'noopener'
    a.click()
  }
}
