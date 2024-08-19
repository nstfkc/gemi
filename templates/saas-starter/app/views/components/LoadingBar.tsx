import { useNavigationProgress } from "gemi/client";

export const LoadingBar = () => {
  const progress = useNavigationProgress();
  return (
    <div
      style={{ opacity: progress === 100 ? 0 : 1 }}
      className="transition-opacity delay-200"
    >
      {progress !== 100 && (
        <div
          style={{
            width: `${progress + 1}%`,
          }}
          className={["transition-[width] ease-linear", "fixed top-0 h-1"].join(
            " ",
          )}
        >
          <div className="h-1 bg-slate-800 animate-pulse w-full"></div>
        </div>
      )}
    </div>
  );
};
