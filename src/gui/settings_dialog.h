// Shuggle — settings_dialog.h
// Global settings (tabs) + per-session settings dialog.
#pragma once
#include <QDialog>
#include <QLabel>
#include <optional>

#include "../core/settings.h"

class QCheckBox;
class QComboBox;
class QDoubleSpinBox;
class QLineEdit;
class QPlainTextEdit;
class QSlider;
class QSpinBox;

namespace shuggle {

class GlobalSettingsDialog : public QDialog {
    Q_OBJECT
public:
    explicit GlobalSettingsDialog(GlobalSettings& settings, QWidget* parent = nullptr);

signals:
    void saved();

private slots:
    void save();

private:
    GlobalSettings& g_;
    // identity
    QLineEdit* name_;
    QComboBox* gender_;
    QLineEdit* gender_custom_;
    QComboBox* sex_;
    QSpinBox* age_;
    QLineEdit* birthday_;
    QComboBox* country_;
    QCheckBox* country_auto_;
    QComboBox* tz_;
    QCheckBox* tz_auto_;
    QComboBox* social_;
    // prompt
    QLineEdit* role_;
    QPlainTextEdit* style_;
    QPlainTextEdit* about_;
    QCheckBox* fancy_;
    QPlainTextEdit* raw_;
    QCheckBox* mem_default_;
    QCheckBox* mem_tools_;
    QLabel* budget_lbl_;
    // model
    QSlider* ctx_;
    QLabel* ctx_lbl_;
    QDoubleSpinBox* temp_;
    QDoubleSpinBox* topp_;
    QSpinBox* max_out_;
    QCheckBox* think_default_;
    // search
    QCheckBox* search_default_;
    QSpinBox* max_queries_;
    QSpinBox* results_per_;
    QCheckBox* digest_;
    // advanced
    QCheckBox* links_inside_;
    QCheckBox* edge_data_;
    QCheckBox* sync_;
};

class SessionSettingsDialog : public QDialog {
    Q_OBJECT
public:
    SessionSettingsDialog(GlobalSettings& global, SessionSettings& target,
                          const std::string& bound_token, QWidget* parent = nullptr);
    bool prompt_changed = false;

signals:
    void saved();

private slots:
    void save();

private:
    GlobalSettings& g_;
    SessionSettings& t_;
    QPlainTextEdit* prompt_;
    QCheckBox* prompt_on_;
    QCheckBox* mem_on_;
    QCheckBox* mem_tools_;
    QCheckBox* search_on_;
    QLineEdit* token_pin_;
    QDoubleSpinBox* temp_;
    QSpinBox* ctx_;
    QLabel* budget_lbl_;
};

} // namespace shuggle
