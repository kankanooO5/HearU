export type HomeTabKey =
  | 'interpreter'
  | 'consecutive'
  | 'history';

type HomeTabProps = {
  active: HomeTabKey;
  disabled?: boolean;
  onChange: (tab: HomeTabKey) => void;
};

type TabIconProps = {
  active: boolean;
};

function InterpreterIcon({
  active,
}: TabIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {active ? (
        <path
          fill="currentColor"
          d="M4.5 11.1h2.3l1.35-3.55a1 1 0 0 1 1.9.08l1.75 6.3 1.9-8.18a1 1 0 0 1 1.95.02l1.65 7.3 1.05-2.1a1 1 0 0 1 .9-.56H21a1 1 0 1 1 0 2h-1.15l-1.95 3.9a1 1 0 0 1-1.87-.23l-1.38-6.1-1.78 7.67a1 1 0 0 1-1.94.04l-1.95-7.04-.55 1.44a1 1 0 0 1-.93.64h-3a1 1 0 1 1 0-2Z"
        />
      ) : (
        <path
          d="M3.5 12h3.3l1.9-5 2.8 10 3-13 2.8 12.2 2.1-4.2H22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function ConsecutiveIcon({
  active,
}: TabIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {active ? (
        <>
          <path
            fill="currentColor"
            d="M3 4.8A2.8 2.8 0 0 1 5.8 2h7.4A2.8 2.8 0 0 1 16 4.8v4.4a2.8 2.8 0 0 1-2.8 2.8H8.1l-3.35 2.6c-.66.52-1.75.05-1.75-.8V4.8Z"
          />
          <path
            fill="currentColor"
            d="M10 14.2h4.2A3.8 3.8 0 0 0 18 10.4V8h.2A2.8 2.8 0 0 1 21 10.8v4.4a2.8 2.8 0 0 1-2.8 2.8h-2.3l-3.35 2.6c-.66.52-1.75.05-1.75-.8V18H10a2.8 2.8 0 0 1-2.74-2.2L10 14.2Z"
          />
        </>
      ) : (
        <>
          <path
            d="M4 5.5A2.5 2.5 0 0 1 6.5 3h6A2.5 2.5 0 0 1 15 5.5v3A2.5 2.5 0 0 1 12.5 11H8l-4 3v-8.5Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10 14h4l4 3v-3h.5a2.5 2.5 0 0 0 2.5-2.5v-3A2.5 2.5 0 0 0 18.5 6H18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

function HistoryIcon({
  active,
}: TabIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {active ? (
        <>
          <path
            fill="currentColor"
            d="M12 2a10 10 0 1 1-8.66 5H2.5a1 1 0 0 1 0-2H6a1 1 0 0 1 1 1v3.5a1 1 0 1 1-2 0V8.05A8 8 0 1 0 12 4a1 1 0 1 1 0-2Z"
          />
          <path
            fill="#ffffff"
            d="M11.2 6.8a1 1 0 0 1 2 0v4.65l2.85 1.64a1 1 0 1 1-1 1.73l-3.35-1.93a1 1 0 0 1-.5-.87V6.8Z"
          />
        </>
      ) : (
        <>
          <path
            d="M6 6H2.5v3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4.15 7A9 9 0 1 1 3 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
          <path
            d="M12 7v5l3 1.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

const items = [
  {
    key: 'interpreter' as const,
    label: '同传',
    Icon: InterpreterIcon,
  },
  {
    key: 'consecutive' as const,
    label: '交传',
    Icon: ConsecutiveIcon,
  },
  {
    key: 'history' as const,
    label: '历史',
    Icon: HistoryIcon,
  },
];

export function HomeTab({
  active,
  disabled = false,
  onChange,
}: HomeTabProps) {
  return (
    <nav
      className="home-tab"
      aria-label="主导航"
    >
      <div className="home-tab-inner">
        {items.map(item => {
          const selected =
            active === item.key;

          const Icon = item.Icon;

          return (
            <button
              key={item.key}
              type="button"
              className={
                selected
                  ? 'home-tab-item active'
                  : 'home-tab-item'
              }
              disabled={disabled}
              aria-current={
                selected
                  ? 'page'
                  : undefined
              }
              onClick={() =>
                onChange(item.key)
              }
            >
              <span className="home-tab-icon">
                <Icon
                  active={selected}
                />
              </span>

              <span className="home-tab-label">
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
