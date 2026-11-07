/** Browser test build: React Native's Alert does nothing in a browser, so use the browser's own confirm. */
export function confirmDialog(title: string, message: string): Promise<boolean> {
  return Promise.resolve(window.confirm(`${title}\n\n${message}`));
}
