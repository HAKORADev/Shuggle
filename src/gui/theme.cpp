// Shuggle — theme.cpp
#include "theme.h"

namespace shuggle {

QString app_stylesheet() {
    return QStringLiteral(R"css(
* { outline: none; }
QWidget { background: #0d0d0d; color: #ececec; font-size: 14px; }
QMainWindow, QDialog { background: #0d0d0d; }

QToolTip { background: #262626; color: #ececec; border: 1px solid #2a2a2a; padding: 6px; }

/* ── sidebar ─────────────────────────────────────────── */
#Sidebar { background: #171717; border-right: 1px solid #2a2a2a; }
#Sidebar QLabel#Brand { color: #ececec; font-weight: 600; }
#NewChatButton {
    background: #212121; border: 1px solid #2a2a2a; border-radius: 10px;
    padding: 10px 14px; text-align: left; color: #ececec;
}
#NewChatButton:hover { background: #2a2a2a; border-color: #3a3a3a; }

QListWidget { background: transparent; border: none; }
QListWidget::item { color: #b9b9b9; padding: 9px 10px; border-radius: 8px; margin: 1px 6px; }
QListWidget::item:hover { background: #212121; color: #ececec; }
QListWidget::item:selected { background: #2a2a2a; color: #ffffff; }

#SearchEdit {
    background: #101010; border: 1px solid #2a2a2a; border-radius: 10px;
    padding: 8px 12px; color: #ececec; selection-background-color: #6d3fc4;
}
#SearchEdit:focus { border-color: #8b5cf6; }

#SectionHeader { color: #8a8a8a; font-size: 11px; letter-spacing: 1px; padding: 4px 10px; }

/* ── buttons ─────────────────────────────────────────── */
QPushButton {
    background: #212121; color: #ececec; border: 1px solid #2a2a2a;
    border-radius: 8px; padding: 7px 14px;
}
QPushButton:hover { background: #2b2b2b; border-color: #3a3a3a; }
QPushButton:pressed { background: #171717; }
QPushButton:disabled { color: #555; border-color: #222; background: #171717; }
QPushButton#SendButton { background: #ececec; color: #0d0d0d; border: none; font-weight: 600; padding: 9px 18px; }
QPushButton#SendButton:hover { background: #ffffff; }
QPushButton#SendButton:disabled { background: #2a2a2a; color: #666; }
QPushButton#DangerButton { color: #e23b3b; }
QPushButton#DangerButton:hover { border-color: #e23b3b; }
QPushButton#GhostButton { background: transparent; border: none; color: #8a8a8a; padding: 5px 8px; }
QPushButton#GhostButton:hover { color: #ececec; background: #212121; border-radius: 6px; }
QPushButton#AccentButton { background: #6d3fc4; color: white; border: none; font-weight: 600; }
QPushButton#AccentButton:hover { background: #8b5cf6; }

/* ── chat area ───────────────────────────────────────── */
QScrollArea { border: none; background: transparent; }
#MessageFrame { border-radius: 12px; }
#MessageFrameUser { background: #1c1c1c; border: 1px solid #2a2a2a; }
#MessageFrameAssistant { background: transparent; }
#RoleLabel { color: #8a8a8a; font-size: 11px; letter-spacing: 1px; }
QTextBrowser {
    background: transparent; border: none; color: #ececec;
    selection-background-color: #6d3fc4; font-size: 14px;
}
QTextBrowser a { color: #a78bfa; }

#ComposerFrame { background: #212121; border: 1px solid #2f2f2f; border-radius: 14px; }
#ComposerEdit {
    background: transparent; border: none; color: #ececec; font-size: 14px;
    selection-background-color: #6d3fc4;
}
#AttachmentChip {
    background: #171717; border: 1px solid #2a2a2a; border-radius: 8px;
    padding: 4px 10px; color: #b9b9b9;
}
#ChipLabel { color: #8a8a8a; font-size: 11px; }
#StatusChip { color: #8a8a8a; font-size: 11px; background: #171717; border-radius: 6px; padding: 2px 8px; }

/* thinking block */
#ThinkingToggle { background: transparent; border: none; color: #8a8a8a; text-align: left; padding: 2px 0; }
#ThinkingToggle:hover { color: #b9a5f5; }
#ThinkingBox { background: #141414; border-left: 2px solid #6d3fc4; border-radius: 4px; color: #9a9a9a; }

/* branch switcher */
#BranchLabel { color: #8a8a8a; font-size: 12px; }
QPushButton#BranchButton { background: transparent; border: none; color: #8a8a8a; padding: 0 6px; font-size: 12px; }
QPushButton#BranchButton:hover { color: #ececec; }

/* ── inputs ──────────────────────────────────────────── */
QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox, QDateTimeEdit {
    background: #101010; border: 1px solid #2a2a2a; border-radius: 8px;
    padding: 7px 10px; color: #ececec; selection-background-color: #6d3fc4;
}
QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus { border-color: #8b5cf6; }
QComboBox QAbstractItemView { background: #1c1c1c; border: 1px solid #2a2a2a; selection-background-color: #2a2a2a; }
QSpinBox::up-button, QSpinBox::down-button, QDoubleSpinBox::up-button, QDoubleSpinBox::down-button {
    background: #212121; border: none; width: 16px;
}
QCheckBox { spacing: 8px; }
QCheckBox::indicator { width: 16px; height: 16px; border: 1px solid #3a3a3a; border-radius: 4px; background: #101010; }
QCheckBox::indicator:checked { background: #8b5cf6; border-color: #8b5cf6; }

QTabWidget::pane { border: 1px solid #2a2a2a; border-radius: 8px; background: #121212; }
QTabBar::tab { background: transparent; color: #8a8a8a; padding: 8px 16px; border: none; }
QTabBar::tab:selected { color: #ececec; border-bottom: 2px solid #8b5cf6; }

QSlider::groove:horizontal { height: 4px; background: #2a2a2a; border-radius: 2px; }
QSlider::handle:horizontal { background: #8b5cf6; width: 14px; height: 14px; margin: -6px 0; border-radius: 7px; }
QSlider::sub-page:horizontal { background: #6d3fc4; border-radius: 2px; }

QProgressBar { background: #1c1c1c; border: none; border-radius: 3px; height: 6px; text-align: center; color: transparent; }
QProgressBar::chunk { background: #8b5cf6; border-radius: 3px; }

QTableWidget { background: #121212; border: 1px solid #2a2a2a; border-radius: 8px; gridline-color: #222; }
QHeaderView::section { background: #171717; color: #8a8a8a; border: none; padding: 8px; }

/* terminal panel */
#TerminalOutput {
    background: #0a0a0a; color: #d0d0d0; border: none;
    font-family: 'Cascadia Mono', 'Consolas', monospace; font-size: 12px;
}
#TerminalBar { background: #141414; border-top: 1px solid #2a2a2a; }

/* scrollbars — slim, quiet */
QScrollBar:vertical { background: transparent; width: 8px; margin: 0; }
QScrollBar::handle:vertical { background: #2e2e2e; border-radius: 4px; min-height: 30px; }
QScrollBar::handle:vertical:hover { background: #3d3d3d; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar:horizontal { background: transparent; height: 8px; margin: 0; }
QScrollBar::handle:horizontal { background: #2e2e2e; border-radius: 4px; min-width: 30px; }
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width: 0; }

QMenu { background: #1c1c1c; border: 1px solid #2a2a2a; border-radius: 8px; padding: 6px; }
QMenu::item { padding: 7px 18px; border-radius: 6px; }
QMenu::item:selected { background: #2a2a2a; }

QDialog { background: #121212; }
QLabel#DialogTitle { font-size: 16px; font-weight: 600; }
QLabel#HintLabel { color: #8a8a8a; font-size: 12px; }
)css");
}

} // namespace shuggle
