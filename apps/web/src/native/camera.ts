// Native camera receipt capture. Produces a File compatible with the existing
// AddTransaction handleFile() → useScanReceipt() path — no backend change.
import { isNativeApp } from './platform';

/**
 * Open the native camera and return the shot as a File, or null when the user
 * cancels (or the bridge is unavailable — version-skew no-op).
 */
export async function capturePhoto(): Promise<File | null> {
  if (!isNativeApp()) return null;
  try {
    const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Base64,
      source: CameraSource.Camera,
      quality: 80,
    });
    if (!photo.base64String) return null;
    const bytes = Uint8Array.from(atob(photo.base64String), (c) => c.charCodeAt(0));
    const format = photo.format || 'jpeg';
    return new File([bytes], `receipt.${format}`, { type: `image/${format}` });
  } catch {
    // User cancelled the camera sheet, or plugin unavailable.
    return null;
  }
}
