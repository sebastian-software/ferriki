       >>SOURCE FORMAT FREE
identification division.
program-id. orders.
environment division.
configuration section.
repository. function all intrinsic.
data division.
working-storage section.
01 order-table.
   05 order-entry occurs 3 times.
      10 customer-name pic x(24).
      10 amount-cents pic 9(8) comp-3.
      10 completed-flag pic x.
         88 completed value "Y".
01 item-index binary-long.
01 total-cents pic 9(10) comp-3 value zero.
01 formatted-total pic Z(8)9.99.
procedure division.
    *> Exact integer cents; exclude canceled orders.
    move "Ada" to customer-name(1)
    move 1995 to amount-cents(1)
    move "Y" to completed-flag(1)
    move "Zoe" to customer-name(2)
    move 1250 to amount-cents(2)
    move "Y" to completed-flag(2)
    move "Ada" to customer-name(3)
    move 500 to amount-cents(3)
    move "N" to completed-flag(3)
    perform varying item-index from 1 by 1 until item-index > 3
        if completed(item-index)
            add amount-cents(item-index) to total-cents
        end-if
    end-perform
    compute formatted-total = total-cents / 100
    display '<total currency="EUR">' trim(formatted-total) '</total>'
    goback.
end program orders.
