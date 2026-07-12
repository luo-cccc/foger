import {
  Zap,
  Search,
  FileOutput,
} from "lucide-react";

export interface QuickActionsProps {
  readonly onAction: (command: string, requestedIntent?: "write_next") => void;
  readonly disabled: boolean;
  readonly isZh: boolean;
  readonly writeNextBlocked?: boolean;
  readonly writeNextBlockedTitle?: string;
}

interface ChipDef {
  readonly icon: React.ReactNode;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly commandZh: string;
  readonly commandEn: string;
  readonly requestedIntent?: "write_next";
}

const CHIPS: ReadonlyArray<ChipDef> = [
  {
    icon: <Zap size={12} />,
    labelZh: "写下一章",
    labelEn: "Write next",
    commandZh: "写下一章",
    commandEn: "write next",
    requestedIntent: "write_next",
  },
  {
    icon: <Search size={12} />,
    labelZh: "审计",
    labelEn: "Audit",
    commandZh: "审计",
    commandEn: "audit",
  },
  {
    icon: <FileOutput size={12} />,
    labelZh: "导出",
    labelEn: "Export",
    commandZh: "导出全书",
    commandEn: "export book",
  },
];

export function QuickActions({
  onAction,
  disabled,
  isZh,
  writeNextBlocked = false,
  writeNextBlockedTitle,
}: QuickActionsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto px-1 py-1">
      {CHIPS.map((chip) => {
        const label = isZh ? chip.labelZh : chip.labelEn;
        const command = isZh ? chip.commandZh : chip.commandEn;
        const actionDisabled = disabled || (chip.requestedIntent === "write_next" && writeNextBlocked);
        return (
          <button
            key={label}
            onClick={() => onAction(command, chip.requestedIntent)}
            disabled={actionDisabled}
            title={chip.requestedIntent === "write_next" && writeNextBlocked
              ? writeNextBlockedTitle
              : undefined}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border/30 text-xs font-medium text-muted-foreground hover:text-primary hover:border-primary/30 hover:bg-primary/5 transition-all disabled:opacity-40 disabled:pointer-events-none group"
          >
            <span className="group-hover:scale-110 transition-transform">{chip.icon}</span>
            {label}
          </button>
        );
      })}
    </div>
  );
}
