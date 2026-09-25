cmake_minimum_required(VERSION 3.20)
project(Poker_Ledger_Reader CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(Poker_Ledger_Reader
        main.cpp
        src/util.cpp
        src/console.cpp
        src/ledger.cpp
        src/players.cpp
        src/settlement.cpp
        src/sessions.cpp
        src/report.cpp
        src/adjustments.cpp
        src/handlog.cpp
        src/seats.cpp
        src/playstyle.cpp
        src/ui.cpp
)

target_include_directories(Poker_Ledger_Reader PRIVATE src)

# The project folder is the default data root, so the app finds the ledger
# folders no matter where CLion puts the executable. Override with --root.
target_compile_definitions(Poker_Ledger_Reader PRIVATE PLR_PROJECT_ROOT="${CMAKE_SOURCE_DIR}")
