type SplashScreenProps = {
  visible: boolean;
};

export function SplashScreen({
  visible,
}: SplashScreenProps) {
  if (!visible) return null;

  return (
    <div
      className="splash-screen"
      aria-hidden="true"
    >
      <div className="splash-symbol">
        <img
          src="/icon.svg"
          alt=""
        />
      </div>

      <div className="splash-wordmark">
        HearU
      </div>
    </div>
  );
}
