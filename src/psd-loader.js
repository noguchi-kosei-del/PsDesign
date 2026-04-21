import { readPsd } from "ag-psd";

function collectTextLayers(layer, out = []) {
  if (layer.text && typeof layer.id === "number") {
    const style = layer.text.style ?? {};
    const orientation = layer.text.orientation;
    out.push({
      id: layer.id,
      name: layer.name ?? "",
      text: layer.text.text ?? "",
      font: style.font?.name ?? "",
      fontSize: style.fontSize ?? null,
      left: layer.left ?? 0,
      top: layer.top ?? 0,
      right: layer.right ?? 0,
      bottom: layer.bottom ?? 0,
      direction: orientation === "vertical" ? "vertical" : "horizontal",
    });
  }
  if (Array.isArray(layer.children)) {
    for (const child of layer.children) collectTextLayers(child, out);
  }
  return out;
}

export async function loadPsdFromPath(path) {
  const bytes = await readFileBytes(path);
  const psd = readPsd(bytes, {
    skipLayerImageData: false,
    skipThumbnail: true,
    useImageData: false,
  });
  const textLayers = [];
  if (Array.isArray(psd.children)) {
    for (const child of psd.children) collectTextLayers(child, textLayers);
  }
  const dpi = psd.imageResources?.resolutionInfo?.horizontalResolution ?? 72;
  return {
    path,
    width: psd.width,
    height: psd.height,
    canvas: psd.canvas,
    textLayers,
    dpi,
  };
}

async function readFileBytes(path) {
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke("read_binary_file", { path });
  return new Uint8Array(bytes);
}
