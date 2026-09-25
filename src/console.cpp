#include "console.hpp"

#include <cctype>
#include <iostream>
#include <limits>

#include "ui.hpp"
#include "util.hpp"

namespace console {

static void discardLine() {
    std::cin.clear();
    std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
}

char askYesNo(const std::string& prompt) {
    while (true) {
        std::cout << prompt;
        std::string line;
        if (!std::getline(std::cin, line)) return 'n';
        line = util::lower(util::trim(line));
        if (line == "y" || line == "yes") return 'y';
        if (line == "n" || line == "no") return 'n';
        std::cout << "Please enter y or n.\n";
    }
}

int askMenuChoice(const std::string& prompt, int minChoice, int maxChoice) {
    while (true) {
        std::cout << prompt;
        int choice = 0;
        if (std::cin >> choice && choice >= minChoice && choice <= maxChoice) {
            discardLine();
            return choice;
        }
        if (std::cin.eof()) return minChoice;
        std::cout << "Invalid choice. Please enter a number between " << minChoice
                  << " and " << maxChoice << ".\n";
        discardLine();
    }
}

double askAmount(const std::string& prompt) {
    while (true) {
        std::cout << prompt;
        double amount = 0.0;
        if (std::cin >> amount && amount >= 0.0) {
            discardLine();
            return amount;
        }
        if (std::cin.eof()) return 0.0;
        std::cout << "Invalid amount. Please enter a non-negative number.\n";
        discardLine();
    }
}

double askSignedAmount(const std::string& prompt) {
    while (true) {
        std::cout << prompt;
        double amount = 0.0;
        if (std::cin >> amount) {
            discardLine();
            return amount;
        }
        if (std::cin.eof()) return 0.0;
        std::cout << "Invalid amount. Enter a number such as 25 or -12.50.\n";
        discardLine();
    }
}

std::string pickPlayer(const std::vector<PlayerStats>& players, const std::string& prompt) {
    std::cout << '\n' << ui::rule(64) << '\n';
    for (size_t i = 0; i < players.size(); ++i) {
        const PlayerStats& p = players[i];
        bool paid = p.adjustments > util::EPSILON || p.adjustments < -util::EPSILON;
        std::cout << util::padLeft(std::to_string(i + 1), 4) << "  " << util::padRight(p.displayName, 22)
                  << util::padLeft(ui::net(p.totalNet), 12)
                  << (paid ? ui::dim("   balance " + util::moneySigned(p.balance())) : "") << '\n';
    }
    std::cout << ui::rule(64) << '\n';
    int choice = askMenuChoice(prompt + " (0 to cancel): ", 0, static_cast<int>(players.size()));
    if (choice == 0) return "";
    return players[choice - 1].normalizedName;
}

std::string askLine(const std::string& prompt) {
    std::cout << prompt;
    std::string input;
    std::getline(std::cin, input);
    return util::trim(input);
}

void pause() {
    std::cout << "(press Enter to continue)";
    std::string line;
    std::getline(std::cin, line);
}

}  // namespace console
