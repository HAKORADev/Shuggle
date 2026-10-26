// Shuggle — token_dialog.h
// Token pool manager: list, add, remove, live usage; "?" big how-to window.
#pragma once
#include <QDialog>
#include <string>

#include "../core/token_manager.h"

class QLabel;
class QListWidget;
class QLineEdit;
class QProgressBar;

namespace shuggle {

class TokenDialog : public QDialog {
    Q_OBJECT
public:
    TokenDialog(TokenManager& tokens, QWidget* parent = nullptr);

signals:
    void pool_changed();

private slots:
    void add_token();
    void remove_selected();
    void refresh_list();
    void show_help();

private:
    void build_help_window();

    TokenManager& tokens_;
    QListWidget* list_;
    QLineEdit* input_;
    QLabel* summary_;
};

} // namespace shuggle
