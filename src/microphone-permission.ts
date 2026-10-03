export type MicrophonePermissionState =
  | 'granted'
  | 'prompt'
  | 'denied'
  | 'unsupported';

export async function getMicrophonePermissionState():
  Promise<MicrophonePermissionState> {
  if (!navigator.permissions?.query) {
    return 'unsupported';
  }

  try {
    const permission =
      await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });

    return permission.state;
  } catch {
    return 'unsupported';
  }
}

export async function watchMicrophonePermission(
  onChange: (
    state: MicrophonePermissionState,
  ) => void,
) {
  if (!navigator.permissions?.query) {
    onChange('unsupported');
    return () => {};
  }

  try {
    const permission =
      await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });

    const update = () => {
      onChange(permission.state);
    };

    update();

    permission.addEventListener(
      'change',
      update,
    );

    return () => {
      permission.removeEventListener(
        'change',
        update,
      );
    };
  } catch {
    onChange('unsupported');
    return () => {};
  }
}

export function acquireMicrophoneStream():
  Promise<MediaStream> {
  if (
    !navigator.mediaDevices?.getUserMedia
  ) {
    return Promise.reject(
      new Error(
        '当前浏览器无法访问麦克风',
      ),
    );
  }

  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
    video: false,
  });
}
