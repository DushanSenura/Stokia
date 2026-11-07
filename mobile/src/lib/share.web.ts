import type { ReportFile } from "./api-client";

/** Browser test build: a browser has no share sheet for files, so download the file instead. */
export async function shareFile(f: ReportFile): Promise<"shared" | "unavailable"> {
  const url = URL.createObjectURL(new Blob([f.bytes as BlobPart], { type: f.mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = f.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "shared";
}
