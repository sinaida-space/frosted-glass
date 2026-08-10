export interface CameraControls {
  list(): Promise<MediaDeviceInfo[]>
  select(deviceId: string): Promise<void>
  get currentId(): string | null
}

const STORAGE_KEY = 'frosted-glass:camera-device-id'

export function installCameraControls(onSelect: (deviceId: string) => Promise<void>): CameraControls {
  let currentId: string | null = null
  try {
    currentId = localStorage.getItem(STORAGE_KEY)
  } catch {
    currentId = null
  }

  async function list(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'videoinput')
  }

  async function select(deviceId: string): Promise<void> {
    currentId = deviceId
    try {
      localStorage.setItem(STORAGE_KEY, deviceId)
    } catch {
      // storage unavailable — keep the in-memory selection only
    }
    await onSelect(deviceId)
  }

  const handleDeviceChange = () => {
    // Re-list is the caller's responsibility via list(); this just signals availability
    // by being a no-op hook point kept for future wiring (task 10 calls list() again).
  }
  navigator.mediaDevices.addEventListener?.('devicechange', handleDeviceChange)

  return {
    list,
    select,
    get currentId() {
      return currentId
    },
  }
}
