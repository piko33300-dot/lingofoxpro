import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Flame, Gem, Heart, Shield, Zap, Sparkles, Tv, Repeat } from "lucide-react";
import { toast } from "sonner";
import { displayStreak, useProgress, progressActions, HEART_REGEN_INTERVAL_MS } from "@/lib/progress-store";
import { getCourse, MAX_HEARTS, REFILL_COST } from "@/lib/lessons";
import { useT } from "@/lib/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function TopBar() {
  const p = useProgress();
  const { t, loc } = useT();
  const navigate = useNavigate();
  const course = getCourse(p.course);
  const streak = displayStreak(p, new Date());

  const [heartsOpen, setHeartsOpen] = useState(false);
  const [gemsOpen, setGemsOpen] = useState(false);
  const [streakOpen, setStreakOpen] = useState(false);

  const minutesUntilNext = (() => {
    if (p.hearts >= MAX_HEARTS || !p.lastHeartLostAt) return 0;
    const elapsed = Date.now() - p.lastHeartLostAt;
    const remainingMs = Math.max(0, HEART_REGEN_INTERVAL_MS - (elapsed % HEART_REGEN_INTERVAL_MS));
    return Math.ceil(remainingMs / (60 * 1000));
  })();

  const handleRefillGems = () => {
    if (p.gems < REFILL_COST) {
      toast.error(t("gemsModalDesc"));
      return;
    }
    progressActions.refillHearts();
    toast.success(t("heartRestored"));
    setHeartsOpen(false);
  };

  const handleRefillAd = () => {
    if (!progressActions.rewardAd()) {
      toast.error(t("adLimit"));
      return;
    }
    toast.success(t("heartRestored"));
    setHeartsOpen(false);
  };

  return (
    <>
      <header className="glass sticky top-0 z-30 border-b border-border/70">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 py-3 font-display font-semibold">
          <Link
            to="/courses"
            className="grid size-10 place-items-center rounded-2xl bg-muted text-2xl ring-1 ring-border transition-transform hover:scale-105 active:scale-95"
            aria-label={`${t("course")}: ${course ? loc(course.title) : ""}`}
          >
            {course?.flag ?? "🌍"}
          </Link>

          <button
            type="button"
            onClick={() => setStreakOpen(true)}
            className="cursor-pointer transition-transform hover:scale-105 active:scale-95"
            aria-label={`${t("streak")}: ${streak}`}
          >
            <Stat
              icon={<Flame className="size-4 fill-flame text-flame" />}
              value={streak}
              label={t("streak")}
              className="text-flame"
            />
          </button>

          <Stat
            icon={<Zap className="size-4 fill-primary text-primary" />}
            value={p.xp}
            label={t("xp")}
            className="text-primary"
          />

          <button
            type="button"
            onClick={() => setGemsOpen(true)}
            className="cursor-pointer transition-transform hover:scale-105 active:scale-95"
            aria-label={`${t("gems")}: ${p.gems}`}
          >
            <Stat
              icon={<Gem className="size-4 fill-gem/30 text-gem" />}
              value={p.gems}
              label={t("gems")}
              className="text-gem"
            />
          </button>

          <button
            type="button"
            onClick={() => setHeartsOpen(true)}
            className="cursor-pointer transition-transform hover:scale-105 active:scale-95"
            aria-label={`${t("hearts")}: ${p.hearts}`}
          >
            <Stat
              icon={<Heart className="size-4 fill-destructive text-destructive" />}
              value={p.hearts}
              label={t("hearts")}
              className="text-destructive"
            />
          </button>
        </div>
      </header>

      {/* Hearts Dialog */}
      <Dialog open={heartsOpen} onOpenChange={setHeartsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="text-center sm:text-center">
            <DialogTitle className="font-display text-2xl font-bold flex items-center justify-center gap-2">
              <Heart className="size-6 fill-destructive text-destructive animate-pulse" />
              {t("heartsModalTitle")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground pt-1">
              {t("heartsModalCurrent", { n: p.hearts })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-center gap-2 py-4">
            {Array.from({ length: MAX_HEARTS }).map((_, i) => (
              <Heart
                key={i}
                className={`size-8 transition-transform ${
                  i < p.hearts
                    ? "fill-destructive text-destructive scale-100"
                    : "fill-muted text-muted-foreground/30 scale-90"
                }`}
              />
            ))}
          </div>

          {p.hearts < MAX_HEARTS && minutesUntilNext > 0 && (
            <p className="text-center font-display text-sm text-muted-foreground">
              {t("heartsNextIn", { m: minutesUntilNext })}
            </p>
          )}

          <div className="space-y-2.5 pt-2">
            <button
              type="button"
              onClick={() => {
                setHeartsOpen(false);
                void navigate({ to: "/practice" });
              }}
              className="btn-3d flex w-full items-center justify-center gap-2.5 bg-primary px-4 py-3 font-display font-semibold text-primary-foreground shadow-[0_4px_0_var(--primary-shade)]"
            >
              <Repeat className="size-5" />
              {t("heartPracticeStart")}
            </button>

            {p.hearts < MAX_HEARTS && (
              <>
                <button
                  type="button"
                  disabled={p.gems < REFILL_COST}
                  onClick={handleRefillGems}
                  className="btn-3d flex w-full items-center justify-center gap-2.5 border-2 border-gem/40 bg-card px-4 py-3 font-display font-semibold text-gem transition-colors hover:bg-gem/10 disabled:opacity-50 shadow-[0_3px_0_rgba(0,0,0,0.1)]"
                >
                  <Gem className="size-5 fill-gem/20" />
                  {t("heartsRefillBtn", { gems: REFILL_COST })}
                </button>

                <button
                  type="button"
                  onClick={handleRefillAd}
                  className="btn-3d flex w-full items-center justify-center gap-2.5 border-2 border-border bg-card px-4 py-2.5 font-display text-sm font-semibold text-foreground transition-colors hover:bg-muted shadow-[0_3px_0_rgba(0,0,0,0.06)]"
                >
                  <Tv className="size-4 text-muted-foreground" />
                  {t("heartsAdBtn")}
                </button>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Gems Dialog */}
      <Dialog open={gemsOpen} onOpenChange={setGemsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="text-center sm:text-center">
            <DialogTitle className="font-display text-2xl font-bold flex items-center justify-center gap-2 text-gem">
              <Gem className="size-6 fill-gem/30" />
              {t("gemsModalTitle")}
            </DialogTitle>
            <DialogDescription className="text-foreground font-semibold pt-1 text-base">
              {t("gemsBalance", { n: p.gems })}
            </DialogDescription>
          </DialogHeader>

          <p className="text-center text-sm text-muted-foreground py-2 leading-relaxed">
            {t("gemsModalDesc")}
          </p>

          <div className="pt-2">
            <button
              type="button"
              onClick={() => {
                setGemsOpen(false);
                void navigate({ to: "/profile" });
              }}
              className="btn-3d flex w-full items-center justify-center gap-2 bg-secondary px-4 py-3 font-display font-semibold text-secondary-foreground shadow-[0_4px_0_rgba(0,0,0,0.2)]"
            >
              <Sparkles className="size-5 text-flame" />
              {t("profile")}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Streak Dialog */}
      <Dialog open={streakOpen} onOpenChange={setStreakOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader className="text-center sm:text-center">
            <DialogTitle className="font-display text-2xl font-bold flex items-center justify-center gap-2 text-flame">
              <Flame className="size-6 fill-flame animate-bounce" />
              {t("streakModalTitle")}
            </DialogTitle>
            <DialogDescription className="text-foreground font-semibold pt-1 text-lg">
              {t("streakCurrent", { n: streak })}
            </DialogDescription>
          </DialogHeader>

          <p className="text-center text-sm text-muted-foreground py-2 leading-relaxed">
            {t("streakModalDesc")}
          </p>

          {p.freezes > 0 && (
            <div className="flex items-center justify-center gap-2 rounded-xl bg-accent p-3 text-sm font-semibold text-accent-foreground">
              <Shield className="size-5 text-gem" />
              <span>{t("streakFreezeEquipped", { n: p.freezes })}</span>
            </div>
          )}

          <div className="pt-2">
            <button
              type="button"
              onClick={() => {
                setStreakOpen(false);
                void navigate({ to: "/profile" });
              }}
              className="btn-3d flex w-full items-center justify-center gap-2 bg-flame px-4 py-3 font-display font-semibold text-white shadow-[0_4px_0_rgba(0,0,0,0.2)]"
            >
              <Flame className="size-5 fill-white" />
              {t("profile")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Stat({ icon, value, label, className }: { icon: ReactNode; value: number; label: string; className: string }) {
  return (
    <span
      aria-label={`${label}: ${value}`}
      className={`flex items-center gap-1 rounded-full bg-card px-2.5 py-1 text-sm shadow-soft ring-1 ring-border/70 ${className}`}
    >
      {icon}
      <span key={value} className="animate-pop font-bold">{value}</span>
    </span>
  );
}
