import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { ReportFile } from "./api-client";

/**
 * Hand a report to the phone's own share sheet (mail, WhatsApp, Drive, "save to files"...). The file is written to the app's private
 * cache only for the moment of sharing and removed straight afterwards, so a report (shop figures) does not linger on the phone.
 */
export async function shareFile(f: ReportFile): Promise<"shared" | "unavailable"> {
  if (!(await Sharing.isAvailableAsync())) return "unavailable";
  const file = new File(Paths.cache, f.fileName);
  try {
    if (file.exists) file.delete();
    file.create();
    await file.write(f.bytes);
    await Sharing.shareAsync(file.uri, { mimeType: f.mime, dialogTitle: f.fileName });
    return "shared";
  } finally {
    try { if (file.exists) file.delete(); } catch { /* best effort */ }
  }
}
