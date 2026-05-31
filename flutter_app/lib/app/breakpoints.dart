const int kMobileBreakpoint = 600;
const int kTabletBreakpoint = 900;

bool isMobile(double width) => width < kMobileBreakpoint;
bool isTablet(double width) =>
    width >= kMobileBreakpoint && width < kTabletBreakpoint;
bool isWide(double width) => width >= kTabletBreakpoint;
