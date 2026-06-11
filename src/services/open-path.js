import { parentDir } from "../utils/path.js";

export async function openContainingFolder(path) {
  const folder = parentDir(path);
  if (!folder) throw new Error("Saved folder not found");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_folder_in_explorer", { path: folder });
}
