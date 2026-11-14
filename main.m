#import <UIKit/UIKit.h>

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property (nonatomic, strong) UIWindow *window;
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    CGRect bounds = [[UIScreen mainScreen] bounds];
    self.window = [[UIWindow alloc] initWithFrame:bounds];
    self.window.backgroundColor = [UIColor whiteColor];

    UIViewController *root = [[UIViewController alloc] init];
    root.view.backgroundColor = [UIColor whiteColor];

    UILabel *title = [[UILabel alloc] initWithFrame:CGRectMake(20, 120, bounds.size.width - 40, 44)];
    title.text = @"Hello iPadOS 13";
    title.font = [UIFont boldSystemFontOfSize:28];
    title.textAlignment = NSTextAlignmentCenter;
    title.textColor = [UIColor blackColor];
    [root.view addSubview:title];

    UILabel *info = [[UILabel alloc] initWithFrame:CGRectMake(20, 190, bounds.size.width - 40, 140)];
    info.numberOfLines = 0;
    info.textAlignment = NSTextAlignmentCenter;
    info.font = [UIFont systemFontOfSize:18];
    info.textColor = [UIColor darkGrayColor];
    info.text = [NSString stringWithFormat:
        @"Device system version: %@\nBuilt with deployment target: 13.0\nUnsigned test build - install OK",
        [[UIDevice currentDevice] systemVersion]];
    [root.view addSubview:info];

    self.window.rootViewController = root;
    [self.window makeKeyAndVisible];
    return YES;
}

@end

int main(int argc, char *argv[]) {
    @autoreleasepool {
        return UIApplicationMain(argc, argv, nil, NSStringFromClass([AppDelegate class]));
    }
}
