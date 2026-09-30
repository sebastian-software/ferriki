#import <Foundation/Foundation.h>

@interface Order : NSObject
@property(nonatomic, copy) NSString *customer;
@property(nonatomic) NSInteger cents;
@property(nonatomic, getter=isCompleted) BOOL completed;
@end
@implementation Order
@end

/* Use integer cents, avoiding per-order floating-point rounding. */
static NSDictionary<NSString *, NSNumber *> *Summarize(NSArray<Order *> *orders) {
    NSMutableDictionary<NSString *, NSNumber *> *totals = [NSMutableDictionary dictionary];
    [orders enumerateObjectsUsingBlock:^(Order *order, NSUInteger index, BOOL *stop) {
        if (order.isCompleted && order.cents >= 0) {
            NSInteger previous = [totals[order.customer] integerValue];
            totals[order.customer] = @(previous + order.cents);
        }
    }];
    return [totals copy];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        Order *order = [Order new];
        order.customer = @"Zoë";
        order.cents = 1250;
        order.completed = YES;
        NSDictionary *totals = Summarize(@[order]);
        for (NSString *customer in [[totals allKeys] sortedArrayUsingSelector:@selector(compare:)]) {
            NSLog(@"<total customer=\"%@\">%@ cents</total>", customer, totals[customer]);
        }
    }
    return 0;
}
